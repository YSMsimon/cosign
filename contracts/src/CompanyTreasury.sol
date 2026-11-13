// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CompanyTreasury
/// @notice Holds a company's USDC. AI agents and team members can only *propose* payments;
///         money leaves only after enough human approvers cosign. Agents get a capped,
///         per-period petty-cash allowance they can draw without approval.
/// @dev On Arc, USDC is the native gas token and `0x3600…0000` is its ERC-20 interface (6 decimals).
contract CompanyTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────── types ───────────────────────────
    struct Proposal {
        address to;
        uint256 amount; // USDC, 6 decimals
        address proposer;
        uint64 createdAt;
        uint8 approvals;
        bool executed;
        bool cancelled;
        string memo;
    }

    struct Allowance {
        uint128 perPeriod; // max USDC an agent can draw per period
        uint64 period; // seconds (e.g. 7 days)
        uint64 periodStart; // start of the current period
        uint128 spentInPeriod; // drawn so far in the current period
    }

    // ─────────────────────────── state ───────────────────────────
    IERC20 public immutable usdc;
    string public name;
    uint8 public immutable threshold; // approvals required to pay a proposal

    mapping(address => bool) public isApprover;
    mapping(address => bool) public isProposer;
    mapping(address => bool) public isGuardian; // can pause only (tighten-only), e.g. a watchdog agent
    address[] private approverList;

    bool public paused;

    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public approvedBy;
    mapping(address => Allowance) public agentAllowance;

    // ─────────────────────────── events ───────────────────────────
    event Deposited(address indexed from, uint256 amount);
    event ProposalCreated(uint256 indexed id, address indexed proposer, address indexed to, uint256 amount, string memo);
    event ProposalApproved(uint256 indexed id, address indexed approver, uint8 approvals);
    event ProposalCancelled(uint256 indexed id, address indexed by);
    event PaymentExecuted(uint256 indexed id, address indexed to, uint256 amount);
    event AllowanceSet(address indexed agent, uint128 perPeriod, uint64 period);
    event AgentToppedUp(address indexed agent, uint256 amount, uint128 spentInPeriod);
    event RoleUpdated(bytes32 indexed role, address indexed account, bool enabled);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─────────────────────────── errors ───────────────────────────
    error NotApprover();
    error NotProposer();
    error NotGuardian();
    error IsPaused();
    error BadInput();
    error UnknownProposal();
    error ProposalClosed();
    error AlreadyApproved();
    error InsufficientBalance();
    error AllowanceExceeded(uint256 available);

    bytes32 public constant ROLE_PROPOSER = keccak256("PROPOSER");
    bytes32 public constant ROLE_GUARDIAN = keccak256("GUARDIAN");

    modifier onlyApprover() {
        if (!isApprover[msg.sender]) revert NotApprover();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    constructor(
        string memory _name,
        IERC20 _usdc,
        address[] memory _approvers,
        address[] memory _proposers,
        uint8 _threshold
    ) {
        if (address(_usdc) == address(0) || _approvers.length == 0) revert BadInput();
        if (_threshold == 0 || _threshold > _approvers.length) revert BadInput();
        name = _name;
        usdc = _usdc;
        threshold = _threshold;
        for (uint256 i; i < _approvers.length; ++i) {
            address a = _approvers[i];
            if (a == address(0) || isApprover[a]) revert BadInput();
            isApprover[a] = true;
            approverList.push(a);
        }
        for (uint256 i; i < _proposers.length; ++i) {
            if (_proposers[i] == address(0)) revert BadInput();
            isProposer[_proposers[i]] = true;
        }
    }

    // ─────────────────────────── funding ───────────────────────────

    /// @notice Accept plain USDC transfers. On Arc, USDC is the native coin, so a wallet "send" to this
    ///         contract arrives as native value (18 decimals) and shares one balance with the ERC-20 view.
    ///         The event reports the 6-decimal amount, matching the ERC-20 interface.
    receive() external payable {
        emit Deposited(msg.sender, msg.value / 1e12);
    }

    /// @notice Pull USDC into the treasury through the ERC-20 interface (caller must `approve` first).
    function deposit(uint256 amount) external {
        if (amount == 0) revert BadInput();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // ─────────────────────────── proposals ───────────────────────────

    /// @notice Draft a payment. Proposers (agents, team) and approvers can propose; nobody can pay alone
    ///         unless the company chose a threshold of 1.
    function propose(address to, uint256 amount, string calldata memo) external whenNotPaused returns (uint256 id) {
        if (!isProposer[msg.sender] && !isApprover[msg.sender]) revert NotProposer();
        if (to == address(0) || to == address(this) || amount == 0) revert BadInput();
        id = proposals.length;
        proposals.push(
            Proposal({
                to: to,
                amount: amount,
                proposer: msg.sender,
                createdAt: uint64(block.timestamp),
                approvals: 0,
                executed: false,
                cancelled: false,
                memo: memo
            })
        );
        emit ProposalCreated(id, msg.sender, to, amount, memo);
    }

    /// @notice Cosign a proposal. Pays automatically when approvals reach the threshold.
    function approve(uint256 id) external onlyApprover whenNotPaused nonReentrant {
        Proposal storage p = _open(id);
        if (approvedBy[id][msg.sender]) revert AlreadyApproved();
        approvedBy[id][msg.sender] = true;
        uint8 n = ++p.approvals;
        emit ProposalApproved(id, msg.sender, n);
        if (n >= threshold) _execute(id, p);
    }

    /// @notice Cancel a proposal. The proposer or any approver can cancel.
    function cancel(uint256 id) external {
        Proposal storage p = _open(id);
        if (msg.sender != p.proposer && !isApprover[msg.sender]) revert NotApprover();
        p.cancelled = true;
        emit ProposalCancelled(id, msg.sender);
    }

    function _open(uint256 id) private view returns (Proposal storage p) {
        if (id >= proposals.length) revert UnknownProposal();
        p = proposals[id];
        if (p.executed || p.cancelled) revert ProposalClosed();
    }

    function _execute(uint256 id, Proposal storage p) private {
        if (usdc.balanceOf(address(this)) < p.amount) revert InsufficientBalance();
        p.executed = true;
        usdc.safeTransfer(p.to, p.amount);
        emit PaymentExecuted(id, p.to, p.amount);
    }

    // ─────────────────────────── agent petty cash ───────────────────────────

    /// @notice Give an agent wallet a petty-cash allowance (perPeriod = 0 revokes it).
    function setAgentAllowance(address agent, uint128 perPeriod, uint64 period) external onlyApprover {
        if (agent == address(0) || (perPeriod > 0 && period == 0)) revert BadInput();
        Allowance storage a = agentAllowance[agent];
        a.perPeriod = perPeriod;
        a.period = period;
        if (a.periodStart == 0) a.periodStart = uint64(block.timestamp);
        emit AllowanceSet(agent, perPeriod, period);
    }

    /// @notice How much the agent can still draw in the current period.
    function availableAllowance(address agent) public view returns (uint256) {
        Allowance memory a = agentAllowance[agent];
        if (a.perPeriod == 0) return 0;
        if (block.timestamp >= uint256(a.periodStart) + a.period) return a.perPeriod;
        return a.spentInPeriod >= a.perPeriod ? 0 : a.perPeriod - a.spentInPeriod;
    }

    /// @notice An agent draws petty cash for itself, within its allowance. No approval needed.
    function topUpAgent(uint256 amount) external whenNotPaused nonReentrant {
        Allowance storage a = agentAllowance[msg.sender];
        if (amount == 0) revert BadInput();
        if (a.perPeriod == 0) revert AllowanceExceeded(0);
        if (block.timestamp >= uint256(a.periodStart) + a.period) {
            // roll to a fresh period aligned to the previous boundaries
            uint256 elapsed = (block.timestamp - a.periodStart) / a.period;
            a.periodStart = uint64(a.periodStart + elapsed * a.period);
            a.spentInPeriod = 0;
        }
        uint256 available = a.spentInPeriod >= a.perPeriod ? 0 : a.perPeriod - a.spentInPeriod;
        if (amount > available) revert AllowanceExceeded(available);
        if (usdc.balanceOf(address(this)) < amount) revert InsufficientBalance();
        a.spentInPeriod += uint128(amount);
        usdc.safeTransfer(msg.sender, amount);
        emit AgentToppedUp(msg.sender, amount, a.spentInPeriod);
    }

    // ─────────────────────────── roles & safety ───────────────────────────

    function setProposer(address account, bool enabled) external onlyApprover {
        if (account == address(0)) revert BadInput();
        isProposer[account] = enabled;
        emit RoleUpdated(ROLE_PROPOSER, account, enabled);
    }

    function setGuardian(address account, bool enabled) external onlyApprover {
        if (account == address(0)) revert BadInput();
        isGuardian[account] = enabled;
        emit RoleUpdated(ROLE_GUARDIAN, account, enabled);
    }

    /// @notice Emergency stop. Approvers and guardians (e.g. a watchdog agent) can pause.
    function pause() external {
        if (!isApprover[msg.sender] && !isGuardian[msg.sender]) revert NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice Only humans (approvers) can resume.
    function unpause() external onlyApprover {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─────────────────────────── views ───────────────────────────

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        if (id >= proposals.length) revert UnknownProposal();
        return proposals[id];
    }

    function approvers() external view returns (address[] memory) {
        return approverList;
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}

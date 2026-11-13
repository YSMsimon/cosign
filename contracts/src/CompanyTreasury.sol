// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CompanyTreasury
/// @notice Holds a company's USDC. AI agents and team members can only *propose* payments;
///         money leaves only after enough human approvers cosign. Agents get a capped,
///         per-period petty-cash allowance they can draw without approval.
///         Approvers can be added or removed, and the threshold changed, through the same
///         cosign flow as a payment, so one approver can never take over a multi-signer treasury.
/// @dev On Arc, USDC is the native gas token and `0x3600…0000` is its ERC-20 interface (6 decimals).
contract CompanyTreasury is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────── types ───────────────────────────
    enum Kind {
        Payment,
        AddApprover,
        RemoveApprover,
        SetThreshold
    }

    struct Proposal {
        Kind kind;
        address to; // payee, or the approver being added / removed
        uint256 amount; // USDC, 6 decimals (payments only)
        uint8 newThreshold; // approver changes: the threshold afterwards (0 = keep)
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
    uint8 public threshold; // approvals required to execute a proposal (changeable by cosign)

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
    event ApproverChangeProposed(uint256 indexed id, address indexed proposer, uint8 kind, address account, uint8 newThreshold, string memo);
    event ApproverAdded(address indexed account);
    event ApproverRemoved(address indexed account);
    event ThresholdChanged(uint8 threshold);

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
                kind: Kind.Payment,
                to: to,
                amount: amount,
                newThreshold: 0,
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

    /// @notice Propose adding or removing an approver, or changing the threshold. Approvers only
    ///         (never agents). It executes after `threshold` cosigns, like a payment, and works while
    ///         the treasury is paused, so a compromised approver can be removed during a pause.
    function proposeApproverChange(Kind kind, address account, uint8 newThreshold, string calldata memo)
        external
        onlyApprover
        returns (uint256 id)
    {
        if (kind == Kind.Payment) revert BadInput();
        if (kind == Kind.AddApprover && (account == address(0) || account == address(this) || isApprover[account])) {
            revert BadInput();
        }
        if (kind == Kind.RemoveApprover && !isApprover[account]) revert BadInput();
        if (kind == Kind.SetThreshold && newThreshold == 0) revert BadInput();
        id = proposals.length;
        proposals.push(
            Proposal({
                kind: kind,
                to: account,
                amount: 0,
                newThreshold: newThreshold,
                proposer: msg.sender,
                createdAt: uint64(block.timestamp),
                approvals: 0,
                executed: false,
                cancelled: false,
                memo: memo
            })
        );
        emit ApproverChangeProposed(id, msg.sender, uint8(kind), account, newThreshold, memo);
    }

    /// @notice Cosign a proposal. Executes automatically when cosigns from CURRENT approvers reach the
    ///         threshold (a removed approver's earlier cosign no longer counts). Payments are blocked
    ///         while paused; approver changes are not.
    function approve(uint256 id) external onlyApprover nonReentrant {
        Proposal storage p = _open(id);
        if (p.kind == Kind.Payment && paused) revert IsPaused();
        if (approvedBy[id][msg.sender]) revert AlreadyApproved();
        approvedBy[id][msg.sender] = true;
        uint8 n = _countApprovals(id);
        p.approvals = n;
        emit ProposalApproved(id, msg.sender, n);
        if (n >= threshold) {
            if (p.kind == Kind.Payment) _execute(id, p);
            else _executeChange(p);
        }
    }

    function _countApprovals(uint256 id) private view returns (uint8 n) {
        for (uint256 i; i < approverList.length; ++i) {
            if (approvedBy[id][approverList[i]]) ++n;
        }
    }

    function _executeChange(Proposal storage p) private {
        p.executed = true;
        address a = p.to;
        if (p.kind == Kind.AddApprover) {
            if (isApprover[a]) revert BadInput();
            isApprover[a] = true;
            approverList.push(a);
            emit ApproverAdded(a);
        } else if (p.kind == Kind.RemoveApprover) {
            if (!isApprover[a]) revert BadInput();
            isApprover[a] = false;
            uint256 last = approverList.length - 1;
            for (uint256 i; i <= last; ++i) {
                if (approverList[i] == a) {
                    approverList[i] = approverList[last];
                    approverList.pop();
                    break;
                }
            }
            emit ApproverRemoved(a);
        }
        if (p.newThreshold != 0 && p.newThreshold != threshold) {
            threshold = p.newThreshold;
            emit ThresholdChanged(threshold);
        }
        // never leave the treasury without approvers or with an unreachable threshold
        if (approverList.length == 0 || threshold == 0 || threshold > approverList.length) revert BadInput();
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

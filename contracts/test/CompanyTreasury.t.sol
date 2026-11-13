// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TreasuryFactory} from "../src/TreasuryFactory.sol";
import {CompanyTreasury} from "../src/CompanyTreasury.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract CompanyTreasuryTest is Test {
    MockUSDC usdc;
    TreasuryFactory factory;
    CompanyTreasury t1; // threshold 1 (founder only)
    CompanyTreasury t2; // threshold 2 (CFO + CEO)

    address cfo = makeAddr("cfo");
    address ceo = makeAddr("ceo");
    address clerk = makeAddr("apClerk"); // agent wallet
    address watchdog = makeAddr("watchdog");
    address vendor = makeAddr("vendor");
    address stranger = makeAddr("stranger");

    uint256 constant USD = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new TreasuryFactory(IERC20(address(usdc)));

        address[] memory one = new address[](1);
        one[0] = cfo;
        address[] memory two = new address[](2);
        two[0] = cfo;
        two[1] = ceo;
        address[] memory props = new address[](1);
        props[0] = clerk;

        t1 = CompanyTreasury(payable(factory.createTreasury("Nova Labs", one, props, 1)));
        t2 = CompanyTreasury(payable(factory.createTreasury("Big Co", two, props, 2)));
        usdc.mint(address(t1), 10_000 * USD);
        usdc.mint(address(t2), 10_000 * USD);
    }

    // ── factory ──
    function test_factoryTracksTreasuries() public view {
        assertEq(factory.treasuryCount(), 2);
        assertEq(factory.treasuriesFor(cfo).length, 2);
        assertEq(factory.treasuriesFor(ceo).length, 1);
        assertEq(t1.name(), "Nova Labs");
        assertEq(t1.threshold(), 1);
    }

    function test_rejectsBadThreshold() public {
        address[] memory one = new address[](1);
        one[0] = cfo;
        vm.expectRevert(CompanyTreasury.BadInput.selector);
        factory.createTreasury("x", one, new address[](0), 2);
    }

    // ── funding: plain native transfers must not revert (Arc native USDC) ──
    function test_acceptsPlainNativeTransfer() public {
        vm.deal(cfo, 5 ether);
        vm.expectEmit(true, false, false, true, address(t1));
        emit CompanyTreasury.Deposited(cfo, 5 * USD); // 5e18 native / 1e12 = 5e6
        vm.prank(cfo);
        (bool ok,) = address(t1).call{value: 5 ether}("");
        assertTrue(ok);
    }

    // ── propose / approve / pay ──
    function test_agentProposes_cfoCosigns_paid() public {
        vm.prank(clerk);
        uint256 id = t1.propose(vendor, 2_400 * USD, "Invoice #118 design work");
        assertEq(usdc.balanceOf(vendor), 0, "nothing moves on propose");

        vm.prank(cfo);
        t1.approve(id);
        assertEq(usdc.balanceOf(vendor), 2_400 * USD);
        assertTrue(t1.getProposal(id).executed);
    }

    function test_twoOfTwo_needsBothSigners() public {
        vm.prank(clerk);
        uint256 id = t2.propose(vendor, 6_000 * USD, "Annual audit");
        vm.prank(cfo);
        t2.approve(id);
        assertEq(usdc.balanceOf(vendor), 0, "one cosign is not enough");
        vm.prank(ceo);
        t2.approve(id);
        assertEq(usdc.balanceOf(vendor), 6_000 * USD);
    }

    function test_agentCannotApprove() public {
        vm.prank(clerk);
        uint256 id = t1.propose(vendor, 100 * USD, "x");
        vm.prank(clerk);
        vm.expectRevert(CompanyTreasury.NotApprover.selector);
        t1.approve(id);
    }

    function test_strangerCannotPropose() public {
        vm.prank(stranger);
        vm.expectRevert(CompanyTreasury.NotProposer.selector);
        t1.propose(vendor, 1 * USD, "x");
    }

    function test_doubleApproveReverts() public {
        vm.prank(clerk);
        uint256 id = t2.propose(vendor, 1 * USD, "x");
        vm.startPrank(cfo);
        t2.approve(id);
        vm.expectRevert(CompanyTreasury.AlreadyApproved.selector);
        t2.approve(id);
        vm.stopPrank();
    }

    function test_cancelledProposalCannotBePaid() public {
        vm.prank(clerk);
        uint256 id = t1.propose(vendor, 1 * USD, "x");
        vm.prank(clerk);
        t1.cancel(id);
        vm.prank(cfo);
        vm.expectRevert(CompanyTreasury.ProposalClosed.selector);
        t1.approve(id);
    }

    function test_insufficientBalanceReverts() public {
        vm.prank(clerk);
        uint256 id = t1.propose(vendor, 20_000 * USD, "too big");
        vm.prank(cfo);
        vm.expectRevert(CompanyTreasury.InsufficientBalance.selector);
        t1.approve(id);
    }

    // ── petty cash ──
    function test_agentTopUpWithinAllowance() public {
        vm.prank(cfo);
        t1.setAgentAllowance(clerk, uint128(20 * USD), 7 days);
        vm.prank(clerk);
        t1.topUpAgent(15 * USD);
        assertEq(usdc.balanceOf(clerk), 15 * USD);
        assertEq(t1.availableAllowance(clerk), 5 * USD);

        vm.prank(clerk);
        vm.expectRevert(abi.encodeWithSelector(CompanyTreasury.AllowanceExceeded.selector, 5 * USD));
        t1.topUpAgent(6 * USD);
    }

    function test_allowanceResetsNextPeriod() public {
        vm.prank(cfo);
        t1.setAgentAllowance(clerk, uint128(20 * USD), 7 days);
        vm.prank(clerk);
        t1.topUpAgent(20 * USD);
        vm.warp(block.timestamp + 7 days);
        assertEq(t1.availableAllowance(clerk), 20 * USD);
        vm.prank(clerk);
        t1.topUpAgent(20 * USD);
        assertEq(usdc.balanceOf(clerk), 40 * USD);
    }

    function test_noAllowanceNoTopUp() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CompanyTreasury.AllowanceExceeded.selector, 0));
        t1.topUpAgent(1 * USD);
    }

    function test_loweringAllowanceBelowSpentDoesNotBrick() public {
        vm.prank(cfo);
        t1.setAgentAllowance(clerk, uint128(20 * USD), 7 days);
        vm.prank(clerk);
        t1.topUpAgent(15 * USD);
        vm.prank(cfo);
        t1.setAgentAllowance(clerk, uint128(10 * USD), 7 days);
        assertEq(t1.availableAllowance(clerk), 0);
    }

    function test_onlyApproverSetsAllowance() public {
        vm.prank(clerk);
        vm.expectRevert(CompanyTreasury.NotApprover.selector);
        t1.setAgentAllowance(clerk, uint128(1_000 * USD), 1 days);
    }

    // ── pause ──
    function test_guardianPauses_onlyHumanUnpauses() public {
        vm.prank(cfo);
        t1.setGuardian(watchdog, true);
        vm.prank(watchdog);
        t1.pause();

        vm.prank(clerk);
        vm.expectRevert(CompanyTreasury.IsPaused.selector);
        t1.propose(vendor, 1 * USD, "x");

        vm.prank(watchdog);
        vm.expectRevert(CompanyTreasury.NotApprover.selector);
        t1.unpause();

        vm.prank(cfo);
        t1.unpause();
        vm.prank(clerk);
        t1.propose(vendor, 1 * USD, "x");
    }

    function test_strangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert(CompanyTreasury.NotGuardian.selector);
        t1.pause();
    }

    // ── fuzz: top-ups never exceed the allowance in a period ──
    function testFuzz_topUpsNeverExceedAllowance(uint96 a, uint96 b) public {
        uint128 cap = uint128(50 * USD);
        vm.prank(cfo);
        t1.setAgentAllowance(clerk, cap, 7 days);
        uint256 x = bound(uint256(a), 1, 60 * USD);
        uint256 y = bound(uint256(b), 1, 60 * USD);
        vm.startPrank(clerk);
        if (x <= cap) t1.topUpAgent(x);
        else {
            vm.expectRevert();
            t1.topUpAgent(x);
            x = 0;
        }
        if (x + y <= cap) t1.topUpAgent(y);
        else {
            vm.expectRevert();
            t1.topUpAgent(y);
            y = 0;
        }
        vm.stopPrank();
        assertLe(usdc.balanceOf(clerk), cap);
        assertEq(usdc.balanceOf(clerk), x + y);
    }
}

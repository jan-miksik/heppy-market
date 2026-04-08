// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Agent, IERC20Like} from "../src/Agent.sol";
import {MockPerpDEX} from "../src/MockPerpDEX.sol";
import {IUSDDemoToken} from "../src/IUSDDemoToken.sol";
import {IUSDDemoFaucet} from "../src/IUSDDemoFaucet.sol";

contract AgentPerpTest is Test {
    Agent internal vault;
    IUSDDemoToken internal iusd;
    IUSDDemoFaucet internal faucet;
    MockPerpDEX internal perpDex;

    address internal alice = makeAddr("alice");
    address internal executor = makeAddr("executor");
    address internal bob = makeAddr("bob");

    bytes32 internal constant MARKET_BTC = keccak256("BTC/USD");
    uint256 internal constant BTC_PRICE = 65_000e18;

    function setUp() external {
        vault = new Agent();
        iusd = new IUSDDemoToken();
        faucet = new IUSDDemoFaucet(address(iusd));
        iusd.setMinter(address(faucet), true);
        perpDex = new MockPerpDEX(address(iusd));

        // Set BTC price
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE);

        vm.deal(alice, 100 ether);
        // Mint iUSD to alice
        vm.prank(alice);
        faucet.mint(100_000e18);

        // Pre-fund MockPerpDEX with liquidity so it can pay out profits
        iusd.setMinter(address(this), true);
        iusd.mint(address(perpDex), 1_000_000e18);
    }

    function _createAndFundAgent() internal returns (uint256 agentId) {
        vm.startPrank(alice);
        agentId = vault.createAgent(bytes("perp-agent"));
        iusd.approve(address(vault), 10_000e18);
        vault.depositToken(agentId, address(iusd), 10_000e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedPerpDex(agentId, address(perpDex), true);
        vault.setAllowedTradeToken(agentId, address(iusd), true);
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, 0, 0);
        vm.stopPrank();
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 60;
    }

    // ── Open Position Tests ──────────────────────────────────────────

    function test_executePerpOpen_opensLongPosition() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 positionId = vault.executePerpOpen(
            agentId,
            address(perpDex),
            MARKET_BTC,
            true, // isLong
            1_000e18, // collateral
            5, // leverage
            BTC_PRICE + 100e18, // acceptable price (above mark for long)
            _deadline()
        );

        assertEq(positionId, 1);
        // Vault balance should be reduced by collateral
        assertEq(vault.tokenBalance(agentId, address(iusd)), 9_000e18);

        // Position should be tracked
        uint256[] memory openIds = vault.getOpenPositionIds(agentId);
        assertEq(openIds.length, 1);
        assertEq(openIds[0], 1);
    }

    function test_executePerpOpen_opensShortPosition() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 positionId = vault.executePerpOpen(
            agentId,
            address(perpDex),
            MARKET_BTC,
            false, // isShort
            2_000e18,
            3,
            BTC_PRICE - 100e18, // acceptable price (below mark for short)
            _deadline()
        );

        assertEq(positionId, 1);
        assertEq(vault.tokenBalance(agentId, address(iusd)), 8_000e18);
    }

    function test_executePerpOpen_rejectsExcessiveLeverage() external {
        uint256 agentId = _createAndFundAgent();

        // Default max leverage is 10
        vm.expectRevert(abi.encodeWithSelector(Agent.InvalidLeverage.selector, 11, 10));
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 11, BTC_PRICE + 100e18, _deadline());
    }

    function test_executePerpOpen_rejectsWhenDexNotAllowed() external {
        uint256 agentId = _createAndFundAgent();

        MockPerpDEX unknownDex = new MockPerpDEX(address(iusd));
        vm.expectRevert(abi.encodeWithSelector(Agent.PerpDexNotAllowed.selector, agentId, address(unknownDex)));
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(unknownDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
    }

    function test_executePerpOpen_rejectsInsufficientBalance() external {
        uint256 agentId = _createAndFundAgent();

        vm.expectRevert(
            abi.encodeWithSelector(Agent.InsufficientTokenBalance.selector, agentId, address(iusd), 20_000e18, 10_000e18)
        );
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 20_000e18, 1, BTC_PRICE + 100e18, _deadline());
    }

    function test_executePerpOpen_rejectsExpiredDeadline() external {
        uint256 agentId = _createAndFundAgent();

        uint256 deadline = block.timestamp + 60;
        vm.warp(deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(Agent.ExecutionPlanExpired.selector, deadline, block.timestamp));
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, deadline);
    }

    function test_executePerpOpen_rejectsWhenPaused() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(alice);
        vault.setPaused(agentId, true);

        vm.expectRevert(abi.encodeWithSelector(Agent.AgentIsPaused.selector, agentId));
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
    }

    // ── Close Position Tests ──────────────────────────────────────────

    function test_executePerpClose_closesLongAtProfit() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 positionId = vault.executePerpOpen(
            agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline()
        );

        // Price goes up 10%
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE * 110 / 100);

        uint256 balBefore = vault.tokenBalance(agentId, address(iusd));

        vm.prank(executor);
        int256 pnl = vault.executePerpClose(agentId, address(perpDex), positionId, 0, _deadline());

        assertTrue(pnl > 0, "PnL should be positive");
        uint256 balAfter = vault.tokenBalance(agentId, address(iusd));
        assertTrue(balAfter > balBefore, "Balance should increase");

        // Position should be removed from tracking
        uint256[] memory openIds = vault.getOpenPositionIds(agentId);
        assertEq(openIds.length, 0);
    }

    function test_executePerpClose_closesLongAtLoss() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 positionId = vault.executePerpOpen(
            agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline()
        );

        // Price goes down 5%
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE * 95 / 100);

        vm.prank(executor);
        int256 pnl = vault.executePerpClose(agentId, address(perpDex), positionId, 0, _deadline());

        assertTrue(pnl < 0, "PnL should be negative");
    }

    function test_executePerpClose_closesShortAtProfit() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 positionId = vault.executePerpOpen(
            agentId, address(perpDex), MARKET_BTC, false, 1_000e18, 3, BTC_PRICE - 100e18, _deadline()
        );

        // Price goes down 10% → short is profitable
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE * 90 / 100);

        vm.prank(executor);
        int256 pnl = vault.executePerpClose(agentId, address(perpDex), positionId, type(uint256).max, _deadline());

        assertTrue(pnl > 0, "Short PnL should be positive on price decrease");
    }

    function test_executePerpClose_rejectsUntrackedPosition() external {
        uint256 agentId = _createAndFundAgent();

        vm.expectRevert(abi.encodeWithSelector(Agent.PerpPositionNotTracked.selector, agentId, 999));
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDex), 999, 0, _deadline());
    }

    // ── Delegation & Limits Tests ─────────────────────────────────────

    function test_executePerpOpen_consumesNotionalLimit() external {
        uint256 agentId;
        vm.startPrank(alice);
        agentId = vault.createAgent(bytes("limited"));
        iusd.approve(address(vault), 10_000e18);
        vault.depositToken(agentId, address(iusd), 10_000e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedPerpDex(agentId, address(perpDex), true);
        vault.setAllowedTradeToken(agentId, address(iusd), true);
        // maxTradeNotional = 500e18
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, uint128(500e18), 0);
        vm.stopPrank();

        // 1000e18 collateral > 500e18 limit
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeNotionalLimitExceeded.selector, agentId, executor, 1_000e18, 500e18)
        );
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
    }

    function test_setMaxLeverage() external {
        uint256 agentId = _createAndFundAgent();

        assertEq(vault.getMaxLeverage(agentId), 10);

        vm.prank(alice);
        vault.setMaxLeverage(agentId, 5);
        assertEq(vault.getMaxLeverage(agentId), 5);

        // Now 6x leverage should be rejected
        vm.expectRevert(abi.encodeWithSelector(Agent.InvalidLeverage.selector, 6, 5));
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 6, BTC_PRICE + 100e18, _deadline());
    }

    function test_multiplePositions() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 pos1 = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 2, BTC_PRICE + 100e18, _deadline());

        vm.prank(executor);
        uint256 pos2 = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, false, 500e18, 3, BTC_PRICE - 100e18, _deadline());

        uint256[] memory openIds = vault.getOpenPositionIds(agentId);
        assertEq(openIds.length, 2);

        // Close first position
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDex), pos1, 0, _deadline());

        openIds = vault.getOpenPositionIds(agentId);
        assertEq(openIds.length, 1);
        assertEq(openIds[0], pos2);
    }

    // ── Owner can trade without delegation ────────────────────────────

    function test_ownerCanTradeDirect() external {
        uint256 agentId;
        vm.startPrank(alice);
        agentId = vault.createAgent(bytes("owner-trade"));
        iusd.approve(address(vault), 5_000e18);
        vault.depositToken(agentId, address(iusd), 5_000e18);
        vault.setAllowedPerpDex(agentId, address(perpDex), true);
        vault.setAllowedTradeToken(agentId, address(iusd), true);
        // No delegated execution enabled — owner can still trade
        uint256 positionId = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
        vm.stopPrank();

        assertEq(positionId, 1);
        assertEq(vault.tokenBalance(agentId, address(iusd)), 4_000e18);
    }
}

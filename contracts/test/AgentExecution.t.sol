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
        Agent.TrackedPosition[] memory openPositions = vault.getOpenPositions(agentId);
        assertEq(openPositions.length, 1);
        assertEq(openPositions[0].positionId, 1);
        assertEq(openPositions[0].perpDex, address(perpDex));
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
        assertEq(vault.getOpenPositions(agentId).length, 0);
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
        // maxTradeNotional = 500e18 notional (collateral × leverage)
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, uint128(500e18), 0);
        vm.stopPrank();

        // 1000e18 collateral × 5 leverage = 5000e18 notional > 500e18 limit
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeNotionalLimitExceeded.selector, agentId, executor, 5_000e18, 500e18)
        );
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
    }

    function test_notionalLimit_reflectsLeveragedExposure() external {
        // maxTradeNotional = 5000e18; collateral = 1000e18 at 5x leverage = 5000e18 notional → exact limit, should pass
        uint256 agentId;
        vm.startPrank(alice);
        agentId = vault.createAgent(bytes("notional-check"));
        iusd.approve(address(vault), 10_000e18);
        vault.depositToken(agentId, address(iusd), 10_000e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedPerpDex(agentId, address(perpDex), true);
        vault.setAllowedTradeToken(agentId, address(iusd), true);
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, uint128(5_000e18), 0);
        vm.stopPrank();

        vm.prank(executor);
        uint256 posId = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());
        assertGt(posId, 0);

        // One unit above the limit (collateral=1001e18, leverage=5 → notional=5005e18 > 5000e18)
        vm.expectRevert(
            abi.encodeWithSelector(Agent.TradeNotionalLimitExceeded.selector, agentId, executor, 5_005e18, 5_000e18)
        );
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_001e18, 5, BTC_PRICE + 100e18, _deadline());
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

        Agent.TrackedPosition[] memory openPositions = vault.getOpenPositions(agentId);
        assertEq(openPositions.length, 2);

        // Close first position
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDex), pos1, 0, _deadline());

        openPositions = vault.getOpenPositions(agentId);
        assertEq(openPositions.length, 1);
        assertEq(openPositions[0].positionId, pos2);
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

    // ── Finding 3: pruneClosedPosition after external liquidation ─────

    function test_prune_afterExternalLiquidation() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 posId = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());

        assertEq(vault.getOpenPositions(agentId).length, 1);

        // Crash price to make position liquidatable (90% loss threshold at 5x leverage → ~18% price drop)
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE * 10 / 100);
        perpDex.liquidatePosition(posId);

        // Position still appears stale in Agent tracking
        assertEq(vault.getOpenPositions(agentId).length, 1);

        // Owner can prune it
        vm.prank(alice);
        vault.pruneClosedPosition(agentId, address(perpDex), posId);

        assertEq(vault.getOpenPositions(agentId).length, 0);
    }

    function test_prune_revertsWhenPositionStillOpen() external {
        uint256 agentId = _createAndFundAgent();

        vm.prank(executor);
        uint256 posId = vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline());

        vm.expectRevert(abi.encodeWithSelector(Agent.PositionStillOpen.selector, agentId, posId));
        vm.prank(alice);
        vault.pruneClosedPosition(agentId, address(perpDex), posId);
    }

    // ── Finding 4: direct ERC-20 transfer does not affect _tokenBalances ─

    function test_directErc20Transfer_remainsStranded() external {
        uint256 agentId = _createAndFundAgent();

        uint256 balanceBefore = vault.tokenBalance(agentId, address(iusd));

        // Transfer tokens directly to the vault contract (not via depositToken)
        vm.prank(alice);
        iusd.transfer(address(vault), 500e18);

        // Agent's tracked balance is unchanged
        assertEq(vault.tokenBalance(agentId, address(iusd)), balanceBefore);

        // Attempting to withdraw more than the tracked balance reverts
        vm.expectRevert(
            abi.encodeWithSelector(Agent.InsufficientTokenBalance.selector, agentId, address(iusd), balanceBefore + 500e18, balanceBefore)
        );
        vm.prank(alice);
        vault.withdrawToken(agentId, address(iusd), balanceBefore + 500e18, alice);
    }

    // ── Finding 12: day-boundary rollover for daily notional allowance ──

    function test_dailyNotional_resetsAfterDayBoundary() external {
        uint256 agentId;
        vm.startPrank(alice);
        agentId = vault.createAgent(bytes("daily-limit"));
        iusd.approve(address(vault), 10_000e18);
        vault.depositToken(agentId, address(iusd), 10_000e18);
        vault.setDelegatedExecutionEnabled(agentId, true);
        vault.setAllowedPerpDex(agentId, address(perpDex), true);
        vault.setAllowedTradeToken(agentId, address(iusd), true);
        // daily notional limit = 2000e18 notional (collateral × leverage)
        vault.setDelegatedExecutorApproval(agentId, executor, true, true, 0, uint128(2_000e18));
        vm.stopPrank();

        // Open a position using 400e18 collateral × 5 leverage = 2000e18 notional — exactly hits daily limit
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 400e18, 5, BTC_PRICE + 100e18, _deadline());

        // Second trade on same day should revert
        vm.expectRevert(
            abi.encodeWithSelector(Agent.DailyTradeNotionalLimitExceeded.selector, agentId, executor, 4_000e18, 2_000e18)
        );
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 400e18, 5, BTC_PRICE + 100e18, _deadline());

        // Warp past midnight UTC (one day)
        vm.warp(block.timestamp + 1 days);

        // Trade should succeed on the new day
        vm.prank(executor);
        vault.executePerpOpen(agentId, address(perpDex), MARKET_BTC, true, 400e18, 5, BTC_PRICE + 100e18, _deadline());
    }

    // ── Finding 1: cross-DEX position-ID collision ────────────────────

    function test_crossDex_positionId_collision_prevented() external {
        // Second DEX, same collateral token — its nextPositionId also starts at 1.
        MockPerpDEX perpDexB = new MockPerpDEX(address(iusd));
        perpDexB.updatePrice(MARKET_BTC, BTC_PRICE);
        iusd.mint(address(perpDexB), 1_000_000e18);

        uint256 agentId = _createAndFundAgent();

        vm.prank(alice);
        vault.setAllowedPerpDex(agentId, address(perpDexB), true);

        // Open only on DEX_A; DEX_B has no position tracked for this agent.
        vm.prank(executor);
        uint256 posA = vault.executePerpOpen(
            agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 2, BTC_PRICE + 100e18, _deadline()
        );
        assertEq(posA, 1);

        // Attempting to close via DEX_B using DEX_A's id must revert BEFORE any external call —
        // the (DEX_B, 1) key is not tracked. Under the old id-only scheme this would have popped
        // DEX_A's tracker entry and then failed later at the DEX, leaving the caller with an
        // ambiguous error surface; now the bad key is rejected up front.
        vm.expectRevert(abi.encodeWithSelector(Agent.PerpPositionNotTracked.selector, agentId, posA));
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDexB), posA, 0, _deadline());

        // Tracker is unchanged after the rejected call.
        Agent.TrackedPosition[] memory openPositions = vault.getOpenPositions(agentId);
        assertEq(openPositions.length, 1);
        assertEq(openPositions[0].perpDex, address(perpDex));
        assertEq(openPositions[0].positionId, posA);

        // Now open a legitimate colliding id on DEX_B. Both coexist independently.
        vm.prank(executor);
        uint256 posB = vault.executePerpOpen(
            agentId, address(perpDexB), MARKET_BTC, true, 1_000e18, 2, BTC_PRICE + 100e18, _deadline()
        );
        assertEq(posB, 1);
        assertEq(vault.getOpenPositions(agentId).length, 2);

        // Each closes independently under its correct DEX.
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDex), posA, 0, _deadline());
        vm.prank(executor);
        vault.executePerpClose(agentId, address(perpDexB), posB, 0, _deadline());
        assertEq(vault.getOpenPositions(agentId).length, 0);
    }

    function test_crossDex_pruneClosedPosition_wrongDex_reverts() external {
        // Prune must also be DEX-scoped: a closed position on DEX_A cannot be pruned as if it
        // belonged to DEX_B (where the agent has no matching tracker entry).
        MockPerpDEX perpDexB = new MockPerpDEX(address(iusd));
        perpDexB.updatePrice(MARKET_BTC, BTC_PRICE);

        uint256 agentId = _createAndFundAgent();
        vm.prank(alice);
        vault.setAllowedPerpDex(agentId, address(perpDexB), true);

        vm.prank(executor);
        uint256 posA = vault.executePerpOpen(
            agentId, address(perpDex), MARKET_BTC, true, 1_000e18, 5, BTC_PRICE + 100e18, _deadline()
        );

        // Liquidate posA directly on DEX_A.
        perpDex.updatePrice(MARKET_BTC, BTC_PRICE * 10 / 100);
        perpDex.liquidatePosition(posA);

        // Pruning via DEX_B must revert — the position is closed at DEX_B's view (it never existed
        // there, so getPosition returns default false), but the tracker has no (DEX_B, posA) entry.
        vm.expectRevert(abi.encodeWithSelector(Agent.PerpPositionNotTracked.selector, agentId, posA));
        vm.prank(alice);
        vault.pruneClosedPosition(agentId, address(perpDexB), posA);
    }
}

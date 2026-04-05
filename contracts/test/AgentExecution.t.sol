// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Agent, IERC20Like} from "../src/Agent.sol";

contract MockERC20 is IERC20Like {
    string public name;
    string public symbol;
    uint8 public immutable decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 bal = balanceOf[msg.sender];
        require(bal >= amount, "insufficient");
        balanceOf[msg.sender] = bal - amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "insufficient");
        allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract MockNativeRouter {
    event NativeHandled(uint256 amount, bytes payload);

    function spend(bytes calldata payload) external payable returns (bytes32) {
        emit NativeHandled(msg.value, payload);
        return keccak256(payload);
    }

    function spendAndRefund(uint256 refundWei, bytes calldata payload) external payable returns (uint256) {
        require(refundWei <= msg.value, "refund>value");
        (bool ok, ) = msg.sender.call{value: refundWei}("");
        require(ok, "refund failed");
        emit NativeHandled(msg.value, payload);
        return refundWei;
    }
}

contract MockTokenRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        IERC20Like(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }
}

contract AgentExecutionTest is Test {
    Agent internal vault;
    MockERC20 internal usdc;
    MockERC20 internal weth;
    MockNativeRouter internal nativeRouter;
    MockTokenRouter internal tokenRouter;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal executor = makeAddr("executor");

    function setUp() external {
        vault = new Agent();
        usdc = new MockERC20("USD Coin", "USDC");
        weth = new MockERC20("Wrapped ETH", "WETH");
        nativeRouter = new MockNativeRouter();
        tokenRouter = new MockTokenRouter();

        vm.deal(alice, 100 ether);
        vm.deal(bob, 50 ether);

        usdc.mint(alice, 1_000_000e18);
        weth.mint(alice, 1_000_000e18);
    }

    function _createAliceAgent(bytes memory metadata) internal returns (uint256 agentId) {
        vm.prank(alice);
        agentId = vault.createAgent(metadata);
    }

    function test_createMultipleAgentsPerUser() external {
        uint256 a1 = _createAliceAgent(bytes("alice-1"));
        uint256 a2 = _createAliceAgent(bytes("alice-2"));

        vm.prank(bob);
        uint256 b1 = vault.createAgent(bytes("bob-1"));

        uint256[] memory aliceAgents = vault.ownerAgentIds(alice);
        uint256[] memory bobAgents = vault.ownerAgentIds(bob);

        assertEq(aliceAgents.length, 2);
        assertEq(aliceAgents[0], a1);
        assertEq(aliceAgents[1], a2);
        assertEq(bobAgents.length, 1);
        assertEq(bobAgents[0], b1);
    }

    function test_nativeDepositAndWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("native"));

        vm.prank(alice);
        vault.depositNative{value: 5 ether}(agentId);

        (, , uint256 nativeBalance, bool exists, , ) = vault.getAgent(agentId);
        assertTrue(exists);
        assertEq(nativeBalance, 5 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        vault.withdrawNative(agentId, 2 ether, payable(alice));
        assertEq(alice.balance, before + 2 ether);

        (, , nativeBalance, , , ) = vault.getAgent(agentId);
        assertEq(nativeBalance, 3 ether);
    }

    function test_tokenDepositAndWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("token"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 400e18);
        vault.depositToken(agentId, address(usdc), 400e18);
        vm.stopPrank();

        assertEq(vault.tokenBalance(agentId, address(usdc)), 400e18);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdrawToken(agentId, address(usdc), 150e18, alice);

        assertEq(vault.tokenBalance(agentId, address(usdc)), 250e18);
        assertEq(usdc.balanceOf(alice), before + 150e18);
    }

    function test_executorCanExecuteTickWhenApproved() external {
        uint256 agentId = _createAliceAgent(bytes("tick"));

        vm.startPrank(alice);
        vault.setAutoSignEnabled(agentId, true);
        vault.setExecutorApproval(agentId, executor, true, false, 0, 0);
        vm.stopPrank();

        vm.prank(executor);
        vault.executeTick(agentId);
    }

    function test_executorTradeRequiresWhitelistedTargetAndLimits() external {
        uint256 agentId = _createAliceAgent(bytes("trade"));

        vm.startPrank(alice);
        vault.depositNative{value: 6 ether}(agentId);
        vault.setAutoSignEnabled(agentId, true);
        vault.setAllowedTarget(agentId, address(nativeRouter), true);
        vault.setExecutorApproval(agentId, executor, false, true, uint128(2 ether), uint128(3 ether));
        vm.stopPrank();

        bytes memory callData = abi.encodeCall(MockNativeRouter.spend, (bytes("first")));
        vm.prank(executor);
        vault.executeTradeCall(agentId, address(nativeRouter), 2 ether, callData);

        vm.expectRevert(
            abi.encodeWithSelector(
                Agent.DailyTradeValueLimitExceeded.selector,
                agentId,
                executor,
                4 ether,
                3 ether
            )
        );
        vm.prank(executor);
        vault.executeTradeCall(agentId, address(nativeRouter), 2 ether, abi.encodeCall(MockNativeRouter.spend, (bytes("second"))));
    }

    function test_tradeCallCreditsNativeRefund() external {
        uint256 agentId = _createAliceAgent(bytes("refund"));

        vm.startPrank(alice);
        vault.depositNative{value: 5 ether}(agentId);
        vault.setAllowedTarget(agentId, address(nativeRouter), true);
        vm.stopPrank();

        bytes memory callData = abi.encodeCall(MockNativeRouter.spendAndRefund, (1 ether, bytes("refund")));
        vm.prank(alice);
        vault.executeTradeCall(agentId, address(nativeRouter), 2 ether, callData);

        (, , uint256 nativeBalance, , , ) = vault.getAgent(agentId);
        assertEq(nativeBalance, 4 ether); // net spent = 1 ether
    }

    function test_executeTokenTradeUpdatesAgentBalances() external {
        uint256 agentId = _createAliceAgent(bytes("token-trade"));

        vm.startPrank(alice);
        usdc.approve(address(vault), 300e18);
        vault.depositToken(agentId, address(usdc), 300e18);
        vault.setAutoSignEnabled(agentId, true);
        vault.setAllowedTarget(agentId, address(tokenRouter), true);
        vault.setExecutorApproval(agentId, executor, false, true, 0, 0);
        vm.stopPrank();

        bytes memory callData = abi.encodeCall(
            MockTokenRouter.swapExactIn,
            (address(usdc), address(weth), 120e18, 105e18)
        );

        vm.prank(executor);
        (uint256 amountInSpent, uint256 amountOutReceived, ) = vault.executeTokenTrade(
            agentId,
            address(tokenRouter),
            address(usdc),
            address(weth),
            120e18,
            100e18,
            0,
            callData
        );

        assertEq(amountInSpent, 120e18);
        assertEq(amountOutReceived, 105e18);
        assertEq(vault.tokenBalance(agentId, address(usdc)), 180e18);
        assertEq(vault.tokenBalance(agentId, address(weth)), 105e18);
    }

    function test_nonOwnerCannotWithdraw() external {
        uint256 agentId = _createAliceAgent(bytes("owner-only"));
        vm.prank(alice);
        vault.depositNative{value: 1 ether}(agentId);

        vm.expectRevert(abi.encodeWithSelector(Agent.NotAgentOwner.selector, agentId, bob));
        vm.prank(bob);
        vault.withdrawNative(agentId, 1 ether, payable(bob));
    }

    function test_executorCannotTradeWhenAutoSignDisabled() external {
        uint256 agentId = _createAliceAgent(bytes("autosign-disabled"));

        vm.startPrank(alice);
        vault.depositNative{value: 2 ether}(agentId);
        vault.setAllowedTarget(agentId, address(nativeRouter), true);
        vault.setExecutorApproval(agentId, executor, false, true, uint128(2 ether), 0);
        vm.stopPrank();

        bytes memory callData = abi.encodeCall(MockNativeRouter.spend, (bytes("no-autosign")));
        vm.expectRevert(abi.encodeWithSelector(Agent.AutoSignDisabled.selector, agentId));
        vm.prank(executor);
        vault.executeTradeCall(agentId, address(nativeRouter), 1 ether, callData);
    }
}

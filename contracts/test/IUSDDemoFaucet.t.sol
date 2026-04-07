// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IUSDDemoToken} from "../src/IUSDDemoToken.sol";
import {IUSDDemoFaucet} from "../src/IUSDDemoFaucet.sol";

contract IUSDDemoFaucetTest is Test {
    IUSDDemoToken internal token;
    IUSDDemoFaucet internal faucet;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() external {
        token = new IUSDDemoToken();
        faucet = new IUSDDemoFaucet(address(token));
        token.setMinter(address(faucet), true);
    }

    function test_mintToCaller() external {
        vm.prank(alice);
        faucet.mint(1_250e18);

        assertEq(token.balanceOf(alice), 1_250e18);
    }

    function test_mintToReceiver() external {
        vm.prank(alice);
        faucet.mintTo(bob, 500e18);

        assertEq(token.balanceOf(bob), 500e18);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_revertWhenMintZero() external {
        vm.expectRevert(IUSDDemoFaucet.ZeroAmount.selector);
        faucet.mint(0);
    }

    function test_revertWhenFaucetNotAuthorizedAsMinter() external {
        token.setMinter(address(faucet), false);
        vm.expectRevert(IUSDDemoToken.NotMinter.selector);
        faucet.mint(1e18);
    }
}

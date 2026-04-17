// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/Script.sol";
import {ScriptBase} from "./ScriptBase.sol";
import {IUSDDemoToken} from "../src/IUSDDemoToken.sol";
import {IUSDDemoFaucet} from "../src/IUSDDemoFaucet.sol";

contract DeployIUSDDemo is ScriptBase {
    function run() external returns (address tokenAddress, address faucetAddress) {
        _startBroadcast();

        IUSDDemoToken token = new IUSDDemoToken();
        IUSDDemoFaucet faucet = new IUSDDemoFaucet(address(token));
        token.setMinter(address(faucet), true);

        vm.stopBroadcast();

        tokenAddress = address(token);
        faucetAddress = address(faucet);

        console.log("iUSD-demo token deployed at:", tokenAddress);
        console.log("iUSD-demo faucet deployed at:", faucetAddress);
        console.log(string.concat("NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_ADDRESS=", vm.toString(tokenAddress)));
        console.log(string.concat("NUXT_PUBLIC_INITIA_SHOWCASE_TOKEN_FAUCET_ADDRESS=", vm.toString(faucetAddress)));
    }
}

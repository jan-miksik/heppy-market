// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IUSDDemoToken} from "../src/IUSDDemoToken.sol";
import {IUSDDemoFaucet} from "../src/IUSDDemoFaucet.sol";

contract DeployIUSDDemo is Script {
    function run() external returns (address tokenAddress, address faucetAddress) {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        address deployer = address(0);
        if (deployerPrivateKey != 0) {
            deployer = vm.addr(deployerPrivateKey);
            vm.startBroadcast(deployerPrivateKey);
        } else {
            deployer = vm.envOr("DEPLOYER", address(0));
            if (deployer != address(0)) {
                vm.startBroadcast(deployer);
            } else {
                vm.startBroadcast();
            }
        }

        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

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

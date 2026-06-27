// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AgentUSD} from "../src/AgentUSD.sol";

contract DeployAgentUSD is Script {
    address constant PAYMENTS_OWNER = 0xF08E2a9D128827615Fca921f278b7bFCBac895E2;

    function run() external {
        vm.startBroadcast();
        // Deploy with msg.sender as temporary owner so we can mint from deployer key
        AgentUSD token = new AgentUSD(msg.sender);
        console.log("AgentUSD deployed to:", address(token));
        // Mint 10,000 aUSD to deployer wallet for testnet payment testing
        token.mint(msg.sender, 10_000 * 10**6);
        console.log("Minted 10,000 aUSD to deployer");
        // Transfer ownership to payments owner
        token.transferOwnership(PAYMENTS_OWNER);
        console.log("Ownership transferred to PAYMENTS_OWNER");
        vm.stopBroadcast();
    }
}

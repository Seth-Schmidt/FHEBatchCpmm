import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { deployer } = await hre.getNamedAccounts();
    const { deploy } = hre.deployments;

    console.log("Deploying test tokens...");
    console.log("Deployer address: ", deployer);

    console.log("Deployer balance: ", await hre.ethers.provider.getBalance(deployer));
    // Deploy test tokens
    const token0 = await deploy("Token0", {
    contract: "FHEConfidentialToken",
    from: deployer,
    args: ["Test Token 0", "TT0"],
    log: true,
    });
    console.log(`Token0 deployed at: ${token0.address}`);
    
    //balance after deployment
    console.log("Deployer balance after deployment: ", await hre.ethers.provider.getBalance(deployer));

    const token1 = await deploy("Token1", {
    contract: "FHEConfidentialToken",
    from: deployer,
    args: ["Test Token 1", "TT1"],
    log: true,
    });
    console.log(`Token1 deployed at: ${token1.address}`);
};

export default func;
func.id = "deploy_tokens";
func.tags = ["tokens"];

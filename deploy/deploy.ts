import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const MIN_BATCH_SIZE = 2;

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  console.log("Deploying FHEBatchCpmmFactory...");
  console.log("Deployer address: ", deployer);
  console.log("Min batch size: ", MIN_BATCH_SIZE);
  console.log("Deployer balance: ", await hre.ethers.provider.getBalance(deployer));
  // Deploy factory
  const factory = await deploy("FHEBatchCpmmFactory", {
    from: deployer,
    args: [MIN_BATCH_SIZE],
    log: true,
  });
  console.log("FHEBatchCpmmFactory deployed at:", factory.address);
  console.log("Deployer balance after deployment: ", await hre.ethers.provider.getBalance(deployer));
};

export default func;
func.id = "deploy_fheBatchCpmmFactory";
func.tags = ["FHEBatchCpmmFactory"];

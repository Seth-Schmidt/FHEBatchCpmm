import { task } from "hardhat/config";

task("task:create-pair", "Create a new CPMM pair")
  .addParam("factory", "Factory contract address")
  .addParam("token0", "Token0 address")
  .addParam("token1", "Token1 address")
  .setAction(async (taskArgs, hre) => {
    const { ethers } = hre;
    const [signer] = await ethers.getSigners();
    
    const factory = await ethers.getContractAt("FHEBatchCpmmFactory", taskArgs.factory, signer);
    
    console.log("Creating pair...");
    const tx = await factory.createPair(taskArgs.token0, taskArgs.token1);
    const receipt = await tx.wait();
    
    // Parse PairCreated event
    const event = receipt?.logs.find((log: any) => {
        try {
          return factory.interface.parseLog(log)?.name === "PairCreated";
        } catch { return false; }
      }) ?? null;
    
    if (event) {
      const parsed = factory.interface.parseLog(event);
      console.log(`Pair created at: ${parsed?.args.pair}`);
    }
  });
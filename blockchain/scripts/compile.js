const solc = require("solc");
const fs = require("fs");
const path = require("path");

function findImport(importPath) {
  const candidates = [
    path.join(__dirname, "node_modules", importPath),
    path.join(__dirname, importPath),
    path.join(__dirname, "contracts", importPath.replace("./", "")),
  ];
  
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: fs.readFileSync(candidate, "utf8") };
    }
  }
  return { error: `File not found: ${importPath}` };
}

// Read all our contracts
const sources = {};
const contractsDir = path.join(__dirname, "contracts");

function addFiles(dir, prefix = "") {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const relPath = prefix ? `${prefix}/${file}` : file;
    if (fs.statSync(fullPath).isDirectory()) {
      addFiles(fullPath, relPath);
    } else if (file.endsWith(".sol")) {
      sources[`contracts/${relPath}`] = { content: fs.readFileSync(fullPath, "utf8") };
    }
  }
}
addFiles(contractsDir);

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "evm.gasEstimates"],
        "": ["ast"]
      },
    },
  },
};

console.log("Compiling contracts...");
console.log(`Sources: ${Object.keys(sources).join(", ")}`);
console.log("");

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

// Check for errors
if (output.errors) {
  let hasError = false;
  for (const err of output.errors) {
    if (err.severity === "error") {
      hasError = true;
      console.error(`ERROR: ${err.formattedMessage}`);
    } else {
      console.warn(`WARNING: ${err.formattedMessage}`);
    }
  }
  if (hasError) {
    console.error("\nCompilation FAILED");
    process.exit(1);
  }
}

// Save artifacts
const artifactsDir = path.join(__dirname, "artifacts");
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

let contractCount = 0;
for (const [sourceName, contracts] of Object.entries(output.contracts || {})) {
  for (const [contractName, data] of Object.entries(contracts)) {
    // Skip interfaces and OZ internals
    if (sourceName.startsWith("@openzeppelin")) continue;
    
    const artifact = {
      contractName,
      sourceName,
      abi: data.abi,
      bytecode: "0x" + (data.evm?.bytecode?.object || ""),
      deployedBytecode: "0x" + (data.evm?.deployedBytecode?.object || ""),
      gasEstimates: data.evm?.gasEstimates,
    };
    
    const artifactPath = path.join(artifactsDir, `${contractName}.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    
    const bytecodeSize = (data.evm?.deployedBytecode?.object || "").length / 2;
    console.log(`  ✓ ${contractName} (${bytecodeSize} bytes deployed)`);
    contractCount++;
  }
}

console.log(`\n✓ ${contractCount} contracts compiled successfully`);
console.log(`  Artifacts saved to: ${artifactsDir}/`);

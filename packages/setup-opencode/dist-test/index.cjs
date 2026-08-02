"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  installOpenCode: () => installOpenCode
});
module.exports = __toCommonJS(index_exports);

// src/main.ts
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var fs = __toESM(require("fs"));
var https = __toESM(require("https"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var import_promises = require("stream/promises");
var MAX_REDIRECTS = 5;
var VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
var CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
function getResponse(url) {
  return new Promise((resolve2, reject) => {
    const request = https.get(
      url,
      { headers: { "user-agent": "ai-review-action/setup-opencode" } },
      resolve2
    );
    request.on("error", reject);
  });
}
async function downloadFile(url, destination, redirects = 0) {
  const response = await getResponse(url);
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error(`OpenCode download exceeded ${MAX_REDIRECTS} redirects`);
    }
    const redirectUrl = new URL(response.headers.location, url).toString();
    await downloadFile(redirectUrl, destination, redirects + 1);
    return;
  }
  if (status !== 200) {
    response.resume();
    throw new Error(`OpenCode download failed with HTTP status ${status}`);
  }
  await (0, import_promises.pipeline)(response, fs.createWriteStream(destination, { flags: "wx", mode: 384 }));
}
function calculateSha256(filePath) {
  return new Promise((resolve2, reject) => {
    const hash = (0, import_crypto.createHash)("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => {
      hash.update(chunk);
    });
    input.on("error", reject);
    input.on("end", () => resolve2(hash.digest("hex")));
  });
}
function resolveInstallDirectory(input) {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}
async function installOpenCode(options) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      `setup-opencode supports only linux-x64 runners; received ${process.platform}-${process.arch}`
    );
  }
  if (!VERSION_PATTERN.test(options.version)) {
    throw new Error(`Invalid OpenCode version '${options.version}'`);
  }
  const expectedChecksum = options.checksum.toLowerCase();
  if (!CHECKSUM_PATTERN.test(expectedChecksum)) {
    throw new Error("checksum must be exactly 64 hexadecimal SHA-256 characters");
  }
  const installDirectory = resolveInstallDirectory(options.installDirectory);
  const assetName = "opencode-linux-x64.tar.gz";
  const downloadUrl = `https://github.com/anomalyco/opencode/releases/download/v${options.version}/${assetName}`;
  const temporaryRoot = process.env.RUNNER_TEMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(path.join(temporaryRoot, "setup-opencode-"));
  const downloadedArchive = path.join(temporaryDirectory, assetName);
  await downloadFile(downloadUrl, downloadedArchive);
  const actualChecksum = await calculateSha256(downloadedArchive);
  if (actualChecksum !== expectedChecksum) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(
      `OpenCode checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`
    );
  }
  const extractionDirectory = path.join(temporaryDirectory, "extracted");
  fs.mkdirSync(extractionDirectory, { mode: 448 });
  const extraction = (0, import_child_process.spawnSync)(
    "tar",
    ["-xzf", downloadedArchive, "-C", extractionDirectory],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (extraction.error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(`Could not extract OpenCode archive: ${extraction.error.message}`);
  }
  if (extraction.status !== 0) {
    const stderr = typeof extraction.stderr === "string" ? extraction.stderr.trim() : "";
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error(
      `OpenCode archive extraction failed with status ${extraction.status}${stderr ? `: ${stderr}` : ""}`
    );
  }
  const extractedBinary = path.join(extractionDirectory, "opencode");
  if (!fs.existsSync(extractedBinary) || !fs.statSync(extractedBinary).isFile()) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw new Error("OpenCode archive did not contain the expected 'opencode' binary");
  }
  fs.mkdirSync(installDirectory, { recursive: true, mode: 493 });
  const installedBinary = path.join(installDirectory, "opencode");
  let stagedBinary = path.join(
    installDirectory,
    `.opencode-${process.pid}-${Date.now().toString(36)}.tmp`
  );
  try {
    fs.copyFileSync(extractedBinary, stagedBinary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedBinary, 493);
    fs.renameSync(stagedBinary, installedBinary);
    stagedBinary = void 0;
  } finally {
    if (stagedBinary) {
      fs.rmSync(stagedBinary, { force: true });
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    version: options.version,
    installDirectory,
    installedBinary
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  installOpenCode
});

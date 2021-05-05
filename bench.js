const fs = require("fs")
const path = require("path")

function errorResult(stderr, step) {
    return { error: true, step, stderr }
}

const cwd = process.cwd();
const gitPath = path.join(cwd, "git")
console.log(`process cwd: ${cwd}; gitPath: ${gitPath}`);

const Mutex = require('async-mutex').Mutex;
const mutex = new Mutex();
var shell = require('shelljs');

var libCollector = require("./collector");

function BenchContext(app, config) {
    var self = this;
    self.app = app;
    self.config = config;

    self.runTask = function(cmd, { title, allowedFailureCodes = [] } = {}) {
        app.log(title || cmd);

        const { stdout, stderr, code } = shell.exec(cmd, { silent: true });
        var error = false;

        if (allowedFailureCodes.includes(code)) {
            app.log(`Command finished with allowed failure code ${code}`)
        } else if (code != 0) {
            app.log(`Command failed; exit code ${code}`);
            if (stderr) {
                app.log(`stderr: ${stderr.trim()}`);
            }
            error = true;
        }

        return { stdout, stderr, error };
    }
}

//::node::import::native::sr25519::transfer_keep_alive::paritydb::small

var BenchConfigs = {
    "import": {
        title: "Import Benchmark (random transfers)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::medium --json'
    },
    "import/small": {
        title: "Import Benchmark (Small block (10tx) with random transfers)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::small --json'
    },
    "import/large": {
        title: "Import Benchmark (Large block (500tx) with random transfers)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::native::sr25519::transfer_keep_alive::rocksdb::large --json'
    },
    "import/full-wasm": {
        title: "Import Benchmark (Full block with wasm, for weights validation)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::wasm::sr25519::transfer_keep_alive::rocksdb::full --json'
    },
    "import/wasm": {
        title: "Import Benchmark via wasm (random transfers)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::wasm::sr25519::transfer_keep_alive::rocksdb::medium --json'
    },
    "ed25519": {
        title: "Import Benchmark (random transfers, ed25519 signed)",
        branchCommand: 'cargo run --release -p node-bench --quiet -- node::import::native::ed25519::transfer_keep_alive::rocksdb::medium --json'
    }
}

const prepareBranch = function({
    owner,
    repo,
    baseBranch,
    branch
}, {
    benchContext
}) {
    if (!fs.existsSync(gitPath)) {
        shell.mkdir(gitPath)
    }

    shell.cd(gitPath)

    var { error, stderr } = benchContext.runTask(
        `git clone https://github.com/${owner}/${repo}`,
        {
            allowedFailureCodes: [
                128, // fatal: destination path 'foo' already exists and is not an empty directory.
            ]
        }
    );
    if (error) return errorResult(stderr);

    shell.cd(path.join(cwd, "git", repo));

    var { error, stderr } = benchContext.runTask("git clean -fd");
    if (error) return errorResult(stderr);

    var { error, stderr } = benchContext.runTask(`git fetch origin ${baseBranch}`);
    if (error) return errorResult(stderr);

    var { error, stderr } = benchContext.runTask(`git reset --hard && git checkout ${baseBranch}`)
    if (error) return errorResult(stderr);

    var { error } = benchContext.runTask(`git branch -D ${branch}`, {
        allowedFailureCodes: [
            1, // error: branch 'foo' not found.
        ]
    })
    if (error) return errorResult(stderr);

    var { error, stderr } = benchContext.runTask(`git fetch origin ${branch}`);
    if (error) return errorResult(stderr);

    var { error, stderr } = benchContext.runTask(`git checkout --track origin/${branch}`);
    if (error) return errorResult(stderr);

    var { error, stderr } = benchContext.runTask(`git reset --hard origin/${branch}`);
    if (error) return errorResult(stderr);
}

async function benchBranch(app, config) {
    app.log("Waiting our turn to run benchmark...")

    const release = await mutex.acquire();

    try {
        if (config.repo != "substrate") {
            return errorResult("Node benchmarks only available on Substrate.")
        }

        var benchConfig = BenchConfigs[config.id || "import"];
        collector = new libCollector.Collector();

        var benchContext = new BenchContext(app, config);
        app.log(`Started benchmark "${benchConfig.title}."`);

        var error = prepareBranch(config, { benchContext })
        if (error) return error;

        var { stderr, error, stdout } = benchContext.runTask(benchConfig.branchCommand);
        if (error) return errorResult(stderr);

        await collector.CollectBaseCustomRunner(stdout);

        var { error, stderr } = benchContext.runTask(`git merge origin/${config.branch}`);
        if (error) return errorResult(stderr, "merge");

        var { stderr, error, stdout } = benchContext.runTask(
            benchConfig.branchCommand,
            {
                title: `Benching branch: ${config.branch}...`
            }
        );

        await collector.CollectBranchCustomRunner(stdout);

        let report = await collector.Report();
        report = `Benchmark: **${benchConfig.title}**\n\n` + report;

        return report;
    }
    catch (error) {
        return errorResult(error.toString());
    }
    finally {
        release();
    }
}

var SubstrateRuntimeBenchmarkConfigs = {
    "pallet": {
        title: "Benchmark Runtime Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--manifest-path=bin/node/cli/Cargo.toml',
            '--',
            'benchmark',
            '--chain=dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--output=./frame/{pallet_folder}/src/weights.rs',
            '--template=./.maintain/frame-weight-template.hbs',
        ].join(' '),
    },
    "substrate": {
        title: "Benchmark Runtime Substrate Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--manifest-path=bin/node/cli/Cargo.toml',
            '--',
            'benchmark',
            '--chain=dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--output=./frame/{pallet_folder}/src/weights.rs',
            '--template=./.maintain/frame-weight-template.hbs',
        ].join(' '),
    },
    "custom": {
        title: "Benchmark Runtime Custom",
        branchCommand: 'cargo run --release --features runtime-benchmarks --manifest-path bin/node/cli/Cargo.toml -- benchmark',
    }
}

var PolkadotRuntimeBenchmarkConfigs = {
    "pallet": {
        title: "Benchmark Runtime Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--',
            'benchmark',
            '--chain=polkadot-dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--header=./file_header.txt',
            '--output=./runtime/polkadot/src/weights/{output_file}',
        ].join(' '),
    },
    "polkadot": {
        title: "Benchmark Runtime Polkadot Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--',
            'benchmark',
            '--chain=polkadot-dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--header=./file_header.txt',
            '--output=./runtime/polkadot/src/weights/{output_file}',
        ].join(' '),
    },
    "kusama": {
        title: "Benchmark Runtime Kusama Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--',
            'benchmark',
            '--chain=kusama-dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--header=./file_header.txt',
            '--output=./runtime/kusama/src/weights/{output_file}',
        ].join(' '),
    },
    "westend": {
        title: "Benchmark Runtime Westend Pallet",
        branchCommand: [
            'cargo run --release',
            '--features=runtime-benchmarks',
            '--',
            'benchmark',
            '--chain=westend-dev',
            '--steps=50',
            '--repeat=20',
            '--pallet={pallet_name}',
            '--extrinsic="*"',
            '--execution=wasm',
            '--wasm-execution=compiled',
            '--heap-pages=4096',
            '--header=./file_header.txt',
            '--output=./runtime/westend/src/weights/{output_file}',
        ].join(' '),
    },
    "custom": {
        title: "Benchmark Runtime Custom",
        branchCommand: 'cargo run --release --features runtime-benchmarks -- benchmark',
    }
}

function checkRuntimeBenchmarkCommand(command) {
    let required = ["benchmark", "--pallet", "--extrinsic", "--execution", "--wasm-execution", "--steps", "--repeat", "--chain"];
    let missing = [];
    for (const flag of required) {
        if (!command.includes(flag)) {
            missing.push(flag);
        }
    }

    return missing;
}

function checkAllowedCharacters(command) {
    let banned = ["#", "&", "|", ";"];
    for (const token of banned) {
        if (command.includes(token)) {
            return false;
        }
    }

    return true;
}

// Push changes through the API so that the commit gets automatically verified by Github
// https://github.community/t/how-to-properly-gpg-sign-github-app-bot-created-commits/131364/2
// Note: As is, this will not work for forks; details inside
const createCommitFromChangedFilesThroughGithubAPI = async function(
    benchContext,
    github,
    { owner, repo, branch, baseSHA, headSHA }
) {
    var {
        error,
        stdout: changedPathsOutput,
        stderr
    } = benchContext.runTask(`git diff --name-only ${baseSHA}`)
    if (error) return errorResult(stderr);

    const changedPaths = changedPathsOutput
        .trim()
        .split("\n")
        .filter(function (path) { return path.length !== 0 })
    if (changedPaths.length === 0) {
        return
    }

    // files need to be uploaded one-by-one because otherwise the JSON payload
    // size might be too big and that would cause the request to fail
    const blobs = []
    for (const filePath of changedPaths) {
        const response = await github.git.createBlob({
            owner,
            repo,
            content: fs.readFileSync(filePath).toString()
        })
        if (response.status === 201) {
            blobs.push({ filePath, sha: response.data.sha })
        } else {
            return errorResult(
                JSON.stringify(createTree.data),
                `failed to create blob for ${filePath}`
            );
        }
    }

    let invalidBlob = -1
    while (true) {
        invalidBlob++
        if (invalidBlob > blobs.length - 1) {
            break
        }

        await new Promise(function (resolve) {
            setTimeout(resolve, 3000)
        })

        const tryBlobs = [...blobs]
        tryBlobs.splice(invalidBlob, 1)

        const tree = tryBlobs
            .map(function ({ filePath, sha }) {
                return {
                    path: filePath,
                    sha,
                    // convert file mode from decimal to Linux's format
                    // https://stackoverflow.com/q/11775884
                    mode: parseInt(fs.statSync(filePath).mode.toString(8), 10).toString(),
                    type: "blob",
                }
            })
        const createTree = await github
            .git
            .createTree({
                owner,
                repo,
                tree,
                base_tree: baseSHA
            })
        if (createTree.status !== 201) {
            continue
            //return errorResult(
                //JSON.stringify(createTree.data),
                //"failed to create a tree with the bench output"
            //);
        }

        const createdTreeSHA = createTree.data.sha
        const createCommit = await github.git.createCommit({
            owner: owner,
            repo: repo,
            tree: createdTreeSHA,
            parents: [baseSHA],
            message: "merge master and add benchmark results"
        })
        if (createCommit.status !== 201) {
            continue
            //return errorResult(
                //JSON.stringify(createCommit.data),
                //"failed to create commit with the bench output"
            //);
        }

        const createdCommitSHA = createCommit.data.sha
        // Does not work for forks' pull requests of github.git.updateRef does not
        // work on them. The workaround is to create a temporary ref, validate the
        // commits there, then pull them back here; of course this is not
        // implemented at the moment.
        const updateBranch = await github.git.updateRef({
            owner,
            repo,
            sha: createdCommitSHA,
            ref: `heads/${branch}`
        })
        if (updateBranch.status !== 200) {
            continue
            //return errorResult(
                //JSON.stringify(updateBranch.data),
                //`failed to update branch ${branch} with the bench output`
            //);
        }

        console.log({ worked: tryBlobs, invalidBlob })
        break
    }
}

async function benchmarkRuntime(app, config, { github }) {
    app.log("Waiting our turn to run benchmark...")

    const release = await mutex.acquire();

    try {
        if (config.extra.split(" ").length < 2) {
            return errorResult(`Incomplete command.`)
        }

        let command = config.extra.split(" ")[0];

        var benchConfig;
        if (config.repo == "substrate") {
            benchConfig = SubstrateRuntimeBenchmarkConfigs[command];
        } else if (config.repo == "polkadot") {
            benchConfig = PolkadotRuntimeBenchmarkConfigs[command];
        } else {
            return errorResult(`${config.repo} repo is not supported.`)
        }

        var extra = config.extra.split(" ").slice(1).join(" ").trim();

        if (!checkAllowedCharacters(extra)) {
            return errorResult(`Not allowed to use #&|; in the command!`);
        }

        // Append extra flags to the end of the command
        let branchCommand = benchConfig.branchCommand;
        if (command == "custom") {
            // extra here should just be raw arguments to add to the command
            branchCommand += " " + extra;
        } else {
            // extra here should be the name of a pallet
            branchCommand = branchCommand.replace("{pallet_name}", extra);
            // custom output file name so that pallets with path don't cause issues
            let outputFile = extra.includes("::") ? extra.replace("::", "_") + ".rs" : '';
            branchCommand = branchCommand.replace("{output_file}", outputFile);
            // pallet folder should be just the name of the pallet, without the leading
            // "pallet_" or "frame_", then separated with "-"
            let palletFolder = extra.split("_").slice(1).join("-").trim();
            branchCommand = branchCommand.replace("{pallet_folder}", palletFolder);
        }

        let missing = checkRuntimeBenchmarkCommand(branchCommand);
        let output = branchCommand.includes("--output");

        if (missing.length > 0) {
            return errorResult(`Missing required flags: ${missing.toString()}`)
        }

        var benchContext = new BenchContext(app, config);
        app.log(`Started runtime benchmark "${benchConfig.title}."`);

        var error = prepareBranch(config, { benchContext })
        if (error) return errorResult(error);

        var { error, stdout } = benchContext.runTask("git rev-parse HEAD");
        if (error) return errorResult(stderr);
        const branchSHABeforeBench = stdout.trim()
        app.log(`Branch SHA before bench: ${branchSHABeforeBench}`)

        // Merge master branch
        var { error, stderr } = benchContext.runTask(`git merge origin/${config.baseBranch}`);
        if (error) return errorResult(stderr);

        var { error, stdout, stderr } = benchContext.runTask(
            branchCommand,
            { title: `Benching branch: ${config.branch}...` }
        );
        if (error) return errorResult(stderr);

        // If `--output` is set, we commit the benchmark file to the repo
        if (output) {
            var { error, stderr } = benchContext.runTask(
                `git commit -am "merge master and add benchmark results"`
            );
            if (error) return errorResult(stderr);

            var error = await createCommitFromChangedFilesThroughGithubAPI(
                benchContext,
                github,
                { ...config, baseSHA: branchSHABeforeBench }
            )

            if (error) {
                return error
            }
        }

        let report = `Benchmark: **${benchConfig.title}**\n\n`
            + branchCommand
            + "\n\n<details>\n<summary>Results</summary>\n\n"
            + (stdout ? stdout : stderr)
            + "\n\n </details>";

        return report;
    }
    catch (error) {
        return errorResult(error.toString());
    }
    finally {
        release();
    }
}

module.exports = {
    benchBranch: benchBranch,
    benchmarkRuntime: benchmarkRuntime,
};

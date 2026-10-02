/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

const childProcess = require('child_process');
const fs = require('fs');

const usage = `
=== Usage ===
node maestro-ios.js <path to app> <app_id> <maestro_flow> <jsengine> <flavor> <working_directory> [device_model] [device_os]

@param {string} appPath - Path to the app APK
@param {string} appId - App ID that needs to be launched
@param {string} maestroFlow - Path to the maestro flow to be executed
@param {string} jsengine - The JSEngine to use for the test
@param {string} flavor - Flavor of the app to be launched. Can be 'Release' or 'Debug'
@param {string} workingDirectory - Working directory from where to run Metro
@param {string} deviceModel - Optional Maestro device model, such as iPhone-17-Pro
@param {string} deviceOS - Optional Maestro device OS, such as iOS-26-2
==============
`;

const MAX_ATTEMPTS = 5;

function findAvailableSimulator(deviceModel, deviceOS) {
  const output = childProcess.execSync(
    'xcrun simctl list devices available -j',
  );
  const devicesByRuntime = JSON.parse(String(output)).devices;

  if ((deviceModel == null) !== (deviceOS == null)) {
    throw new Error('Device model and OS must be configured together');
  }

  if (deviceModel != null && deviceOS != null) {
    const runtime = `com.apple.CoreSimulator.SimRuntime.${deviceOS}`;
    const simulatorName = deviceModel.replaceAll('-', ' ');
    const simulator = devicesByRuntime[runtime]?.find(
      device => device.name === simulatorName,
    );

    if (simulator == null) {
      throw new Error(
        `Unable to find ${simulatorName} simulator on ${deviceOS}`,
      );
    }

    return simulator;
  }

  const devices = Object.values(devicesByRuntime).flat().reverse();
  const simulator = devices.find(device => /^iPhone .* Pro$/.test(device.name));

  if (simulator == null) {
    throw new Error('Unable to find an available iPhone Pro simulator');
  }

  return simulator;
}

function launchSimulator(simulator) {
  console.log(`Launching simulator ${simulator.name} (${simulator.udid})`);
  try {
    childProcess.execSync(`xcrun simctl boot "${simulator.udid}"`);
  } catch (error) {
    if (
      !error.message.includes('Unable to boot device in current state: Booted')
    ) {
      throw error;
    }
  }
  // `simctl boot` returns before the simulator has finished booting, and an
  // install sent then can hang (seen on GitHub's macOS runners). Wait for the
  // boot to complete first, bounded so a simulator that never boots fails the
  // step instead of holding it.
  console.log('Waiting for the simulator to finish booting');
  const start = Date.now();
  childProcess.execSync(`xcrun simctl bootstatus "${simulator.udid}" -b`, {
    stdio: 'ignore',
    timeout: 1000 * 60 * 15,
  });
  console.log(`Simulator booted after ${Math.round((Date.now() - start) / 1000)}s`);
}

function installAppOnSimulator(appPath, udid) {
  console.log(`Installing app at path ${appPath}`);
  childProcess.execSync(`xcrun simctl install "${udid}" "${appPath}"`);
}

function bringSimulatorInForeground() {
  console.log('Bringing simulator in foreground');
  childProcess.execSync('open -a simulator');
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function launchAppOnSimulator(appId, udid, isDebug) {
  console.log('Launch the app');
  childProcess.execSync(`xcrun simctl launch "${udid}" "${appId}"`);

  if (isDebug) {
    console.log('Wait for metro to warm');
    await sleep(20 * 1000);
  }
}

function startVideoRecording(udid, currentAttempt) {
  console.log(
    `Start video record using pid: video_record_${currentAttempt}.pid`,
  );

  const recordingArgs =
    `simctl io ${udid} recordVideo --force video_record_${currentAttempt}.mov`.split(
      ' ',
    );
  const recordingProcess = childProcess.spawn('xcrun', recordingArgs, {
    detached: true,
    stdio: 'ignore',
  });

  return recordingProcess;
}

// The movie is only written after SIGINT, so returning early truncates it.
const RECORDING_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

function stopVideoRecording(recordingProcess) {
  if (!recordingProcess) {
    console.log("Passed a null recording process. Can't kill it");
    return Promise.resolve();
  }

  console.log(`Stop video record using pid: ${recordingProcess.pid}`);

  if (
    recordingProcess.exitCode != null ||
    recordingProcess.signalCode != null
  ) {
    return Promise.resolve();
  }

  // Awaiting the exit is also what reaps the child: the flows run in a
  // synchronous loop, so nothing else turns the event loop.
  return new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.log(
        `Recorder ${recordingProcess.pid} did not exit in time, killing it`,
      );
      recordingProcess.kill('SIGKILL');
      // SIGKILL on an already-exited process is a no-op that emits no `exit`,
      // so resolve here instead of waiting for an event that may never come.
      done();
    }, RECORDING_SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();

    recordingProcess.once('exit', done);
    recordingProcess.once('error', done);
    recordingProcess.kill('SIGINT');

    // The process may have exited between the guard above and attaching the
    // listeners; that `exit` event is already gone, so re-check and resolve.
    if (
      recordingProcess.exitCode != null ||
      recordingProcess.signalCode != null
    ) {
      done();
    }
  });
}

async function executeFlowWithRetries(
  appId,
  udid,
  flow,
  jsengine,
  currentAttempt,
) {
  const recProcess = startVideoRecording(udid, currentAttempt);
  try {
    const timeout = 1000 * 60 * 10; // 10 minutes
    // maestro-runner instead of Maestro; same flow, same APP_ID. Its JUnit
    // report is copied to report.xml, where `maestro --format junit` wrote it.
    const out = `/tmp/MaestroRunner/attempt-${currentAttempt}`;
    const command = `$HOME/.maestro-runner/bin/maestro-runner --platform ios --device "${udid}" test -e APP_ID="${appId}" --output ${out} --flatten "${flow}"; rc=$?; cp ${out}/junit-report.xml report.xml 2>/dev/null; exit $rc`;
    console.info(`Executing flow: ${flow} (attempt ${currentAttempt})`);
    console.log(command);
    childProcess.execSync(`MAESTRO_DRIVER_STARTUP_TIMEOUT=1500000 ${command}`, {
      stdio: 'inherit',
      timeout,
    });

    await stopVideoRecording(recProcess);
  } catch (error) {
    await stopVideoRecording(recProcess);

    if (currentAttempt < MAX_ATTEMPTS) {
      console.info(`Retrying flow: ${flow}`);
      await executeFlowWithRetries(
        appId,
        udid,
        flow,
        jsengine,
        currentAttempt + 1,
      );
    } else {
      console.error(
        `Failed to execute flow ${flow} after ${MAX_ATTEMPTS} attempts.`,
      );
      throw error;
    }
  }
}

// Same flow list as executeFlows: sorted, recursing into folders except
// helpers/, which holds runFlow fragments.
function collectFlows(maestroFlow) {
  if (!fs.existsSync(maestroFlow) || !fs.lstatSync(maestroFlow).isDirectory()) {
    return [maestroFlow];
  }
  const flows = [];
  for (const file of fs.readdirSync(maestroFlow).sort()) {
    const filePath = `${maestroFlow.replace(/\/$/, '')}/${file}`;
    if (fs.lstatSync(filePath).isDirectory()) {
      if (file !== 'helpers') {
        flows.push(...collectFlows(filePath));
      }
    } else if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      flows.push(filePath);
    }
  }
  return flows;
}

// maestro-runner batch mode: all flows run in one maestro-runner process, so
// the iOS agent stays up between flows. Flows that fail are run again in the
// same process (--retries), up to MAX_ATTEMPTS runs in total, as the
// per-flow retries did.
async function executeFlowsBatch(appId, udid, maestroFlow) {
  const flows = collectFlows(maestroFlow);
  const out = '/tmp/MaestroRunner/run';
  const list = flows.map(flow => `"${flow}"`).join(' ');
  const command = `$HOME/.maestro-runner/bin/maestro-runner --platform ios --device "${udid}" test -e APP_ID="${appId}" --retries ${MAX_ATTEMPTS - 1} --output ${out} --flatten ${list}`;
  console.info(`Executing ${flows.length} flow(s) in one maestro-runner run`);
  console.log(command);
  const recProcess = startVideoRecording(udid, 1);
  try {
    childProcess.execSync(command, {
      stdio: 'inherit',
      timeout: 1000 * 60 * 120,
    });
  } catch (error) {
    // Per-flow results are read from report.json below.
  }
  await stopVideoRecording(recProcess);
  try {
    fs.copyFileSync(`${out}/junit-report.xml`, 'report.xml');
  } catch (error) {}
  const statuses = {};
  try {
    const report = JSON.parse(fs.readFileSync(`${out}/report.json`, 'utf8'));
    for (const flow of report.flows ?? []) {
      statuses[flow.sourceFile.split('/').pop()] = flow.status;
    }
  } catch (error) {
    console.error(`Could not read ${out}/report.json: ${error}`);
  }
  const failed = flows.filter(
    flow => statuses[flow.split('/').pop()] !== 'passed',
  );
  if (failed.length > 0) {
    throw new Error(
      `Failed to execute ${failed.length} flow(s) after ${MAX_ATTEMPTS} attempts:\n${failed.join('\n')}`,
    );
  }
}

async function executeFlows(appId, udid, maestroFlow, jsengine) {
  if (!fs.existsSync(maestroFlow) || !fs.lstatSync(maestroFlow).isDirectory()) {
    await executeFlowWithRetries(appId, udid, maestroFlow, jsengine, 1);
    return;
  }

  for (const file of fs.readdirSync(maestroFlow).sort()) {
    const filePath = `${maestroFlow.replace(/\/$/, '')}/${file}`;
    if (fs.lstatSync(filePath).isDirectory()) {
      // Fragments pulled in via `runFlow`; they have no `launchApp` of their
      // own and fail when run standalone.
      if (file === 'helpers') {
        continue;
      }
      await executeFlows(appId, udid, filePath, jsengine);
    } else if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      await executeFlowWithRetries(appId, udid, filePath, jsengine, 1);
    }
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length < 6 || args.length > 8) {
    throw new Error(`Invalid number of arguments.\n${usage}`);
  }

  const appPath = args[0];
  const appId = args[1];
  const maestroFlow = args[2];
  const jsengine = args[3];
  const isDebug = args[4] === 'Debug';
  const workingDirectory = args[5];
  const deviceModel = args[6] || null;
  const deviceOS = args[7] || null;

  console.info('\n==============================');
  console.info('Running tests for iOS with the following parameters:');
  console.info(`APP_PATH: ${appPath}`);
  console.info(`APP_ID: ${appId}`);
  console.info(`MAESTRO_FLOW: ${maestroFlow}`);
  console.info(`JS_ENGINE: ${jsengine}`);
  console.info(`IS_DEBUG: ${isDebug}`);
  console.info(`WORKING_DIRECTORY: ${workingDirectory}`);
  console.info(`DEVICE_MODEL: ${deviceModel ?? '<automatic>'}`);
  console.info(`DEVICE_OS: ${deviceOS ?? '<automatic>'}`);
  console.info('==============================\n');

  const simulator = findAvailableSimulator(deviceModel, deviceOS);
  launchSimulator(simulator);
  installAppOnSimulator(appPath, simulator.udid);
  bringSimulatorInForeground();
  await launchAppOnSimulator(appId, simulator.udid, isDebug);
  await executeFlowsBatch(appId, simulator.udid, maestroFlow);
  console.log('Test finished');
}

if (require.main === module) {
  main();
}

module.exports = {
  executeFlows,
  findAvailableSimulator,
};

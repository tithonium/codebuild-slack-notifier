import { MessageAttachment, WebClient } from '@slack/web-api';
import {
  Channel,
  findMessageForId,
  MessageResult,
  updateOrAddAttachment,
} from './slack';
import * as AWS from "aws-sdk";

const s3 = new AWS.S3();
const S3_SLACK_COMMIT_BUCKET = process.env.S3_SLACK_COMMIT_BUCKET;
const ERRORS_TO_DISPLAY = 5;

/**
 * See https://docs.aws.amazon.com/codebuild/latest/userguide/sample-build-notifications.html#sample-build-notifications-ref
 */
export type CodeBuildPhase =
  | 'QUEUED'
  | 'SUBMITTED'
  | 'PROVISIONING'
  | 'DOWNLOAD_SOURCE'
  | 'INSTALL'
  | 'PRE_BUILD'
  | 'BUILD'
  | 'POST_BUILD'
  | 'UPLOAD_ARTIFACTS'
  | 'FINALIZING'
  | 'COMPLETED';

export type CodeBuildStatus =
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'TIMED_OUT'
  | 'STOPPED'
  | 'FAILED'
  | 'SUCCEEDED'
  | 'FAULT'
  | 'CLIENT_ERROR';

const PHASE_MAP_TO_REAL = {
  'QUEUED': "IDLE",
  'SUBMITTED': "START",
  'PROVISIONING': "SUPPLY",
  'DOWNLOAD_SOURCE': "SOURCE",
  'INSTALL': "INSTALL",
  'PRE_BUILD': "PULL",
  'BUILD': "BUILD",
  'POST_BUILD': "TEST",
  'UPLOAD_ARTIFACTS': "RESULT",
  'FINALIZING': "EXIT",
  'COMPLETED': "DONE"
};

interface CodeBuildEnvironmentVariable {
  name: string;
  value: string;
  type: 'PLAINTEXT' | 'SSM';
}

interface CodeBuildPhaseInformation {
  'phase-context'?: string[];
  'start-time': string;
  'end-time'?: string;
  'duration-in-seconds'?: number;
  'phase-type': CodeBuildPhase;
  'phase-status'?: CodeBuildStatus;
}

interface CodeBuildEventAdditionalInformation {
  artifact?: {
    md5sum?: string;
    sha256sum?: string;
    location: string;
  };
  environment: {
    image: string;
    'privileged-mode': boolean;
    'compute-type':
    | 'BUILD_GENERAL1_SMALL'
    | 'BUILD_GENERAL1_MEDIUM'
    | 'BUILD_GENERAL1_LARGE';
    type: 'LINUX_CONTAINER';
    'environment-variables': CodeBuildEnvironmentVariable[];
  };
  'timeout-in-minutes': number;
  'build-complete': boolean;
  initiator: string;
  'build-start-time': string;
  source: {
    buildspec?: string;
    auth?: {
      type: string; // can be 'OAUTH' and possibly other values
    };
    location: string;
    type: 'S3' | 'GITHUB';
  };
  'source-version'?: string;
  logs?: {
    'group-name': string;
    'stream-name': string;
    'deep-link': string;
  };
  phases?: CodeBuildPhaseInformation[];
}

export interface CodeBuildStateEvent {
  version: string;
  id: string;
  'detail-type': 'CodeBuild Build State Change';
  source: 'aws.codebuild';
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: {
    'build-status': CodeBuildStatus;
    'project-name': string;
    'build-id': string;
    'additional-information': CodeBuildEventAdditionalInformation;
    'current-phase': CodeBuildPhase;
    'current-phase-context': string;
    version: string;
  };
}

export interface CodeBuildPhaseEvent {
  version: string;
  id: string;
  'detail-type': 'CodeBuild Build Phase Change';
  source: 'aws.codebuild';
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: {
    'completed-phase': CodeBuildPhase;
    'project-name': string;
    'build-id': string;
    'completed-phase-context': string;
    'completed-phase-status': CodeBuildStatus;
    'completed-phase-duration-seconds': number;
    version: string;
    'completed-phase-start': string;
    'completed-phase-end': string;
    'additional-information': CodeBuildEventAdditionalInformation;
  };
}

export type CodeBuildEvent = CodeBuildStateEvent | CodeBuildPhaseEvent;

export const buildStatusToColor = (status) => {
  try {
    switch (status) {
      case 'IN_PROGRESS':
        return '#439FE0';
      case 'SUCCEEDED':
        return 'good';
      case 'TIMED_OUT':
        return 'danger';
      case 'STOPPED':
        return 'danger';
      case 'FAILED':
        return 'danger';
      case 'FAULT':
        return 'warning';
      case 'CLIENT_ERROR':
        return 'warning';
      default:
        return '#439FE0';
    }
  } catch (e) {
    console.log(e);
    return '#439FE0';
  }
};

const buildStatusToText = (status) => {
  try {
    switch (status) {
      case 'IN_PROGRESS':
        return 'started';
      case 'SUCCEEDED':
        return 'passed';
      case 'TIMED_OUT':
        return 'timed out';
      case 'STOPPED':
        return 'stopped';
      case 'FAILED':
        return 'failed';
      case 'FAULT':
        return 'errored';
      case 'CLIENT_ERROR':
        return 'had client error';
      default:
        return 'started';
    }
  } catch (e) {
    console.log(e);
    return 'started';
  }
};

export const projectLink = (event: CodeBuildEvent): string => {
  try {
    return `<https://${
      event.region
      }.console.aws.amazon.com/codebuild/home?region=${event.region}#/projects/${
      event.detail['project-name']
      }/view|benchpress-server>`;
  } catch (e) {
    console.log(e);
    return "null";
  }

};

// Get the build ID from the Codebuild event
export const buildId = (event: CodeBuildEvent): string => {
  try {
    return event.detail['build-id'].split(':').slice(-1)[0];
  } catch (e) {
    console.log(e);
    return "0";
  }

};

export const buildARN = (event: CodeBuildEvent): string => {
  try {
    return event.detail['build-id'].split('/')[1];
  } catch (e) {
    console.log(e);
    return "0";
  }
}
// Convert seconds to minutes + seconds
export const timeString = (seconds: number | undefined): string => {
  const minute = 60;
  if (seconds !== undefined) {
    return `${
      seconds > minute ? `${Math.floor(seconds / minute)}m` : ''
      }${seconds % minute}s`;
  }
  return '';
};

// Git revision, possibly with URL
const gitRevision = (event) => {
  try {
    if (additionalInformation(event, "source").type === 'GITHUB') {
      const sourceVersion = additionalInformation(event, 'source-version');
      if (sourceVersion === undefined) {
        return 'unknown';
      }
      const githubProjectUrl = additionalInformation(event, 'source').location.slice(0, -('.git'.length));
      // PR
      const pr = sourceVersion.match(/^pr\/(\d+)/);
      if (pr) {
        return `<${githubProjectUrl}/pull/${pr[1]}|Pull request #${pr[1]}>`;
      }
      // Commit (a commit sha has a length of 40 chars)
      if (sourceVersion.length === 40) { // tslint:disable-line:no-magic-numbers
        return `<${githubProjectUrl}/commit/${sourceVersion}|${sourceVersion.slice(0, 8)}>`;
      }
      // Branch
      return `<${githubProjectUrl}/tree/${sourceVersion}|${sourceVersion}>`;
    }
    return additionalInformation(event, 'source-version') || 'unknown';
  } catch (e) {
    console.log(e);
    return 'unknown';
  }
};

const s3Handle = (commitId, fileName) => {
  return {
    Bucket: S3_SLACK_COMMIT_BUCKET,
    Key: `commits/${commitId}/${fileName}`
  };
}

function eventToCommitId(event: CodeBuildEvent) {
  return event.detail['additional-information']['source-version'];
}

function linkS3Bucket(commitId, name) {
  if (!commitId || !name) return "";
  return `S3_SLACK_COMMIT_BUCKET/commits/${commitId}/${name}`;
}

function formatFailures(failures, commitId) {
  try {
    if (failures.length <= 0) return '';

    const lines = failures.slice(0, ERRORS_TO_DISPLAY).join('\n');
    return failures.length > ERRORS_TO_DISPLAY ?
      ['```', lines, '```', `<${linkS3Bucket(commitId, "spec-failed.txt")}|Download all ${failures.length} errors`].join('\n').trim() :
      ['```', lines, '```'].join('\n').trim();
  } catch (e) {
    console.log(e);
    return "";
  }
}

function formatCopFailures(failures, commitId) {
  try {
    if (failures.length <= 0) return '';

    const lines = failures.slice(0, ERRORS_TO_DISPLAY).join('\n');
    return failures.length > ERRORS_TO_DISPLAY ?
      ['```', lines, '```', `<${linkS3Bucket(commitId, "rubocop_failures.txt")}|Download all ${failures.length} errors`].join('\n').trim() :
      ['```', lines, '```'].join('\n').trim();
  } catch (e) {
    console.log(e);
    return "";
  }
}


function parseFailures(failures) {
  try {
    if (failures == "") return [];

    let lines = failures.split('\n')
      .filter(
        line =>
          line != "" && line != " "
      )
      .map(
        line => {
          return `${line.split('|')[0].trim()}`;
        }
      )
    return lines;
  } catch (e) {
    console.log(e);
    return [];
  }
}

function parseCopFailures(failures) {
  try {
    if (failures == "") return [];

    let lines = failures.split('\n')
      .filter(
        line =>
          line.startWith('== ')
      ).map(
        line =>
          line.match(/== (.+) ==/)[1]
      )
    return lines;
  } catch (e) {
    console.log(e);
    return [];
  }
}

function failedMessage(phaseType, buildStatus, opts) {
  opts = opts || {};
  switch (phaseType) {
    case 'POST_BUILD':
      return combinedFailedMessage(opts)
    default:
      return `Phase ${phaseName(phaseType)} ${buildStatusToText(buildStatus)}`;
  }
}

function combinedFailedMessage(opts) {
  const specFailedMessage = opts.failedCount <= 0 ?
                             '' :
                             (opts.failedCount > 1 ? `${opts.failedCount} tests failed` : `1 test failed`)
  const copsFailedMessage = opts.copFailedCount <= 0 ?
                             '' :
                             (opts.copFailedCount > 1 ? `${opts.copFailedCount} files failed linting` : `1 file failed linting`)
  return (specFailedMessage && copsFailedMessage) ?
           `${specFailedMessage} and ${copsFailedMessage}` :
           (specFailedMessage || copsFailedMessage)
}

function phaseName(phase) {
  return PHASE_MAP_TO_REAL[phase] || phase;
}

function additionalInformation(event, key) {
  try {
    return event.detail['additional-information'][key];
  } catch (e) {
    console.log(e);
    return "";
  }
}

async function getObject(handle, utf8) {
  try {
    console.log(handle.Key)
    const data = await s3.getObject(handle).promise();

    return utf8 ? data.Body.toString('utf-8') : data.Body.toString();
  } catch (e) {
    console.log(e);
    return "";
  }
}

export const buildPhaseAttachment = (event) => {
  try {
    const phases = additionalInformation(event, "phases") || [];
    if (phases.length > 0) {
      const stagePhases = {
        setup: phases
          .filter(
            phase =>
              phase['phase-type'] == 'SUBMITTED' ||
              phase['phase-type'] == 'PROVISIONING' ||
              phase['phase-type'] == 'DOWNLOAD_SOURCE' ||
              phase['phase-type'] == 'INSTALL' ||
              phase['phase-type'] == 'PRE_BUILD' ||
              phase['phase-type'] == 'QUEUED'
          ),
        build: phases
          .filter(
            phase =>
              phase['phase-type'] == 'BUILD'
          ),
        test: phases
          .filter(
            phase =>
              phase['phase-type'] == 'POST_BUILD'
          )
      };

      const stageCompleted = {
        setup: stagePhases.build.length > 0,
        build: stagePhases.test.length > 0,
        test: phases.filter(phase => (phase['phase-type'] === 'UPLOAD_ARTIFACTS')).length > 0,
      };

      const stageSucceeded = {
        setup: stagePhases.setup
          .filter(
            phase =>
              phase['phase-status'] != null &&
              phase['phase-status'] !== 'SUCCEEDED',
          ).length == 0,
        build: stagePhases.build
          .filter(
            phase =>
              phase['phase-status'] != null &&
              phase['phase-status'] !== 'SUCCEEDED',
          ).length == 0,
        test: stagePhases.test
          .filter(
            phase =>
              phase['phase-status'] != null &&
              phase['phase-status'] !== 'SUCCEEDED',
          ).length == 0,
      };

      const stageTimes = {
        setup: stagePhases.setup
          .filter(phase => phase['duration-in-seconds'] > 0)
          .map(phase => phase['duration-in-seconds'])
          .reduce((previousValue, currentValue) => previousValue + currentValue, 0) || 0,
        build: stagePhases.build
          .filter(phase => phase['duration-in-seconds'] >= 0)
          .map(phase => phase['duration-in-seconds'])
          .reduce((previousValue, currentValue) => previousValue + currentValue, 0) || 0,
        test: stagePhases.test
          .filter(phase => phase['duration-in-seconds'] > 0)
          .map(phase => phase['duration-in-seconds'])
          .reduce((previousValue, currentValue) => previousValue + currentValue, 0) || 0,
      };

      var resultText = '';

      // Setup
      resultText += (stageCompleted.setup) ? `${
        stageSucceeded.setup ? ':white_check_mark:' : ':x:'
        } SETUP (${timeString(stageTimes.setup)})` : `:building_construction: SETUP`;


      // Build
      if (stageCompleted.setup) {
        resultText += ' ';
        resultText += (stageCompleted.build) ? `${
          stageSucceeded.build ? ':white_check_mark:' : ':x:'
          } BUILD (${timeString(stageTimes.build)})` : `:building_construction: BUILD`;
      }

      // Test
      if (stageCompleted.build) {
        resultText += ' ';
        resultText += (stageCompleted.test) ? `${
          stageSucceeded.test ? ':white_check_mark:' : ':x:'
          } TEST (${timeString(stageTimes.test)})` : `:building_construction: TEST`;
      }

      return {
        fallback: `Current phase: ${event.detail['completed-phase']}`,
        text: resultText,
        title: 'Stages',
      };

    } else {
      return {
        fallback: `not started yet`,
        text: '',
        title: 'Stages',
      };
    }

  } catch (e) {
    console.log(e);
    return {
      fallback: `not started yet`,
      text: '',
      title: 'Stages',
    };
  }
};

// Construct the build message
const buildEventToMessage = (event, gitDetails, failureMsg, copFailureMsg, opts) => {
  const startTime = Date.parse(
    additionalInformation(event, 'build-start-time'),
  );

  // URL to the Codebuild view for the build
  const buildUrl = `https://${event.region}.console.aws.amazon.com/codebuild/home?region=${event.region}#/builds/${buildARN(event)}/view/new`;

  const minute = 60;
  const msInS = 1000;
  const endTime = Date.parse(event.time);
  const elapsedTime = endTime - startTime;
  const minutes = Math.floor(elapsedTime / minute / msInS);
  const seconds = Math.floor(elapsedTime / msInS - minutes * minute);

  const minutesText = minutes ? `${minutes} min ` : '';
  const secondsText = seconds ? `${seconds} sec` : '';
  const buildFailed = (additionalInformation(event, "phases") || [])
    .filter(
      phase =>
        phase['phase-status'] != null &&
        phase['phase-status'] !== 'SUCCEEDED',
    ).length > 0;
  const buildPassed = (additionalInformation(event, "phases") || [])
    .filter(
      phase =>
        phase['phase-status'] === 'SUCCEEDED' &&
        phase['phase-type'] === 'POST_BUILD'
    ).length > 0;

  if (!event.detail['build-status']) {
    if (buildFailed) event.detail['build-status'] = 'FAILED';
    else if (buildPassed) event.detail['build-status'] = 'SUCCEEDED';
    else event.detail['build-status'] = 'IN_PROGRESS';
  }
  const buildMsg = `<${buildUrl}|Build> of ${projectLink(event)} ${buildStatusToText(event.detail['build-status'])} (${minutesText}${secondsText})`;

  console.log(`>> Message: ${buildMsg}`);

  let combinedFailureMsg = (failureMsg && copFailureMsg) ?
                             `${failureMsg}\n${copFailureMsg}` :
                             (failureMsg || copFailureMsg)

  return [
    {
      color: buildStatusToColor(event.detail['build-status']),
      fallback: buildMsg,
      fields: [
        {
          short: false,
          title: '',
          value: `${[gitDetails.trim(), gitRevision(event).trim()].join('\n').trim()}`,
        },
        ...(additionalInformation(event, "phases") || [])
          .filter(
            phase =>
              phase['phase-status'] != null &&
              phase['phase-status'] !== 'SUCCEEDED',
          )
          .map(phase => ({
            short: false,
            title: failedMessage(phase['phase-type'], event.detail['build-status'], opts),
            value: combinedFailureMsg
          })),
      ],
      footer: buildId(event),
      text: buildMsg,
    },
    buildPhaseAttachment(event),
  ];
};

// Handle the event for one channel
export const handleCodeBuildEvent = async (event, slack, channel) => {
  const commitId = eventToCommitId(event);
  const gitDetailsHandle = s3Handle(commitId, "git-details.txt");
  const failuresHandle = s3Handle(commitId, "spec-failed.txt");
  const copFailuresHandle = s3Handle(commitId, "rubocop_failures.txt");
  const gitDetails = await getObject(gitDetailsHandle, false) || "";
  const failures = await getObject(failuresHandle, true) || "";
  const copFailures = await getObject(copFailuresHandle, true) || "";
  const bid = buildId(event);
  let parsedFailures = parseFailures(failures);
  let parsedCopFailures = parseCopFailures(copFailures);
  let failureMsg = formatFailures(parsedFailures, commitId);
  let copFailureMsg = formatCopFailures(parsedCopFailures, commitId);

  console.log(`~~ [${event['detail-type']}] ${event.detail["completed-phase"]} | ${event.detail["completed-phase-status"]} | ${additionalInformation(event, "build-complete") == true ? "COMPLETE" : "INCOMPLETE"} | ${gitDetails} | ${failureMsg} | ${copFailureMsg}`);
  let message = await findMessageForId(slack, channel.id, bid);
  if (message) {
    await slack.chat.update({
      attachments: buildEventToMessage(event, gitDetails, failureMsg, copFailureMsg, { failedCount: parsedFailures.length, copFailedCount: parsedCopFailures.length }),
      channel: channel.id,
      text: '',
      ts: message.ts,
    });

    message = await findMessageForId(slack, channel.id, bid);
    return await slack.chat.update({
      attachments: updateOrAddAttachment(
        message.attachments,
        attachment => attachment.title === 'Stages',
        buildPhaseAttachment(event),
      ),
      channel: channel.id,
      text: '',
      ts: message.ts,
    });
  } else {
    return await slack.chat.postMessage({
      attachments: buildEventToMessage(event, gitDetails, failureMsg, copFailureMsg, { failedCount: parsedFailures.length, copFailedCount: parsedCopFailures.length }),
      channel: channel.id,
      text: '',
    });
  }
};

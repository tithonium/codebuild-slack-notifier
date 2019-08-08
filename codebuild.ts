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
      }/view|${event.detail['project-name']}>`;
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
const gitRevision = (event: CodeBuildEvent): string => {
  try {
    if (event.detail['additional-information'].source.type === 'GITHUB') {
      const sourceVersion =
        event.detail['additional-information']['source-version'];
      if (sourceVersion === undefined) {
        return 'unknown';
      }
      const githubProjectUrl = event.detail['additional-information'].source.location.slice(0, -('.git'.length));
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
    return event.detail['additional-information']['source-version'] || 'unknown';
  } catch (e) {
    console.log(e);
  }
};

async function getObject(handle) {
  try {
    console.log(handle.Key)
    const data = await s3.getObject(handle).promise();

    return data.Body.toString();
  } catch (e) {
    console.log(e);
    return "";
  }
}

const s3Handle = (commitId, fileName) => {
  return {
    Bucket: S3_SLACK_COMMIT_BUCKET,
    Key: `commits/${commitId}/${fileName}`
  };
}

function eventToCommitId(event: CodeBuildEvent) {
  return event.detail['additional-information']['source-version'];
}

// Git revision, possibly with URL
const gitDetails = function (commitLog) {
  return commitLog;
};

function hasSucceeded(status) {
  return status === 'SUCCEEDED';
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

export const buildPhaseAttachment = (
  event: CodeBuildEvent,
): MessageAttachment => {
  try {
    const phases = additionalInformation(event, "phases");
    if (phases) {
      const startPhases = phases
        .filter(
          phase =>
            (phase['phase-type'] == 'SUBMITTED' ||
              phase['phase-type'] == 'PROVISIONING' ||
              phase['phase-type'] == 'DOWNLOAD_SOURCE' ||
              phase['phase-type'] == 'INSTALL' ||
              phase['phase-type'] == 'PRE_BUILD' ||
              phase['phase-type'] == 'QUEUED') &&
            phase['phase-status']

        );
      // const endPhases = phases
      //   .filter(
      //     phase =>
      //       (phase['phase-type'] == 'UPLOAD_ARTIFACTS' ||
      //         phase['phase-type'] == 'FINALIZING' ||
      //         phase['phase-type'] == 'COMPLETED') &&
      //       phase['phase-status']
      //   );

      const totalStartSeconds = startPhases
        .map(phase => phase['duration-in-seconds'] !== undefined ? phase['duration-in-seconds'] : 0)
        .reduce((previousValue, currentValue) => previousValue + currentValue, 0) || 0;

      const startSucceeded = startPhases
        .map(phase => phase['phase-status'] || "SUCCEEDED")
        .every(hasSucceeded) || false;

      // const totalEndSeconds = endPhases
      //   .map(phase => phase['duration-in-seconds'] !== undefined ? phase['duration-in-seconds'] : 0)
      //   .reduce((previousValue, currentValue) => previousValue + currentValue, 0) || 0;

      // const endSucceeded = endPhases
      //   .map(phase => phase['phase-status'])
      //   .every(hasSucceeded) || false;

      var resultText = '';

      resultText += (totalStartSeconds > 0 && startPhases.length >= 5) ? `${
        startSucceeded ? ':white_check_mark:' : ':x:'
        } SETUP (${timeString(totalStartSeconds)})` : `:building_construction: SETUP`;

      resultText += ' ';
      resultText += phases
        .filter(
          phase =>
            phase['phase-type'] === 'BUILD' ||
            phase['phase-type'] === 'POST_BUILD'
        )
        .map(phase => {
          if (phase['duration-in-seconds'] !== undefined) {
            return `${
              phase['phase-status'] === 'SUCCEEDED'
                ? ':white_check_mark:'
                : ':x:'
              } ${phaseName(phase['phase-type'])} (${timeString(
                phase['duration-in-seconds'],
              )})`;
          }
          return `:building_construction: ${phaseName(phase['phase-type'])}`;
        })
        .join(' ');

      return {
        fallback: `Current phase: ${phases[phases.length - 1]['phase-type']}`,
        text: resultText,
        title: 'Build Phases',
      };
    }

  } catch (e) {
    console.log(e);
    return {
      fallback: `not started yet`,
      text: '',
      title: 'Build Phases',
    };
  }

  return {
    fallback: `not started yet`,
    text: '',
    title: 'Build Phases',
  };
};

// Construct the build message
const buildEventToMessage = (
  event: CodeBuildEvent,
  commitLog: any,
  commitTestResults: any
): MessageAttachment[] => {
  const startTime = Date.parse(
    additionalInformation(event, 'build-start-time'),
  );

  // URL to the Codebuild view for the build
  const buildUrl = `https://${
    event.region
    }.console.aws.amazon.com/codebuild/home?region=${event.region}#/builds/${
    buildARN(event)
    }/view/new`;

  if (additionalInformation(event, 'build-complete')) {
    const minute = 60;
    const msInS = 1000;
    const endTime = Date.parse(event.time);
    const elapsedTime = endTime - startTime;
    const minutes = Math.floor(elapsedTime / minute / msInS);
    const seconds = Math.floor(elapsedTime / msInS - minutes * minute);

    const completeText = `<${buildUrl}|Build> of ${projectLink(event)} ${buildStatusToText(event.detail['build-status'])} after ${
      minutes ? `${minutes} min ` : ''
      }${seconds ? `${seconds} sec` : ''}`;

    console.log("Completed text:", completeText);
    return [
      {
        color: buildStatusToColor(event.detail['build-status']),
        fallback: completeText,
        fields: [
          {
            short: false,
            title: 'Git revision',
            value: gitRevision(event),
          },
          {
            short: false,
            title: 'Details',
            value: gitDetails(commitLog),
          },
          ...(additionalInformation(event, "phases") || [])
            .filter(
              phase =>
                phase['phase-status'] != null &&
                phase['phase-status'] !== 'SUCCEEDED',
            )
            .map(phase => ({
              short: false,
              title: failedMessage(phase['phase-type'], event.detail['build-status']),
              value: commitTestResults || (phase['phase-context'] || []).join('\n'),
            })),
        ],
        footer: buildId(event),
        text: completeText,
      },
      buildPhaseAttachment(event),
    ];
  }

  const text = `<${buildUrl}|Build> of ${projectLink(event)} ${buildStatusToText(event.detail['build-status'])}`;
  return [
    {
      text,
      color: buildStatusToColor(event.detail['build-status']),
      fallback: text,
      fields: [
        {
          short: true,
          title: 'Git revision',
          value: gitRevision(event),
        },
        {
          short: false,
          title: 'Details',
          value: gitDetails(commitLog),
        },
      ],
      footer: buildId(event),
    },
    buildPhaseAttachment(event),
  ];
};

function failedMessage(phaseType, buildStatus) {
  switch (phaseType) {
    case 'POST_BUILD':
      return "Tests failed";
    default:
      return `Phase ${phaseName(phaseType)} ${buildStatusToText(buildStatus)}`;
  }
}

// Handle the event for one channel
export const handleCodeBuildEvent = async (
  event: CodeBuildEvent,
  slack: WebClient,
  channel: Channel,
): Promise<MessageResult | void> => {
  // State change event
  const commitId = eventToCommitId(event);
  const gitHandle = s3Handle(commitId, "git-details.txt");

  let commitLog = await getObject(gitHandle);
  const specHandle = s3Handle(commitId, "spec-failed.txt");
  const commitTestResults = await getObject(specHandle);

  if (event['detail-type'] === 'CodeBuild Build State Change') {
    console.log(`
      ~~ State Changed ~~
      Current Phase: ${event.detail["current-phase"]}
      Build Status: ${event.detail["build-status"]}
      Build Completed: ${additionalInformation(event, "build-complete")}
    `);

    console.log("commitLog", commitLog)

    if (additionalInformation(event, 'build-complete')) {

      const stateMessage = await findMessageForId(
        slack,
        channel.id,
        buildId(event),
      );
      if (stateMessage) {
        console.log(`
          Slack State Message: ${stateMessage}
        `);
        return slack.chat.update({
          attachments: buildEventToMessage(event, commitLog, commitTestResults),
          channel: channel.id,
          text: '',
          ts: stateMessage.ts,
        }) as Promise<MessageResult>;
      }
      console.log('Slack state message is empty!');
    }

    console.log(`Posting new message to Slack --
      ${commitLog}
    `);

    return slack.chat.postMessage({
      attachments: buildEventToMessage(event, commitLog, ""),
      channel: channel.id,
      text: '',
    }) as Promise<MessageResult>;
  }
  // Phase change event

  console.log(`
    ~~ Phase Changed ~~
    Completed Phase: ${event.detail["completed-phase"]}
    Completed Phase Status: ${event.detail["completed-phase-status"]}
    Build Completed: ${additionalInformation(event, "build-complete")}
  `);
  let message = await findMessageForId(slack, channel.id, buildId(event));
  console.log('after findMessageForId');
  if (message) {
    await slack.chat.update({
      attachments: buildEventToMessage(event, commitLog, commitTestResults),
      channel: channel.id,
      text: '',
      ts: message.ts,
    })
    message = await findMessageForId(slack, channel.id, buildId(event));
    return slack.chat.update({
      attachments: updateOrAddAttachment(
        message.attachments,
        attachment => attachment.title === 'Build Phases',
        buildPhaseAttachment(event),
      ),
      channel: channel.id,
      text: '',
      ts: message.ts,
    }) as Promise<MessageResult>;
  }
};

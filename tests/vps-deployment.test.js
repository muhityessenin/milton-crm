"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createVpsDeploymentService, loadDeploymentConfig, fingerprintForHostKey, buildStartCommand, parseStatusOutput } = require("../server/vps-deployment");

const configuredEnv = {
  VPS_DEPLOY_HOST:"203.0.113.10",
  VPS_DEPLOY_PORT:"22",
  VPS_DEPLOY_USER:"ubuntu",
  VPS_DEPLOY_PASSWORD:"secret",
  VPS_DEPLOY_HOST_FINGERPRINT:"SHA256:test",
  VPS_DEPLOY_PATH:"/opt/milton-crm",
};

test("deployment configuration reports missing secrets without exposing values", () => {
  const empty=loadDeploymentConfig({});
  assert.deepEqual(empty.missing,["VPS_DEPLOY_HOST","VPS_DEPLOY_USER","VPS_DEPLOY_PASSWORD","VPS_DEPLOY_HOST_FINGERPRINT"]);
  const service=createVpsDeploymentService({env:configuredEnv,executor:async()=>({code:0,stdout:"started\n",stderr:""})});
  const description=service.describe();
  assert.equal(description.configured,true);
  assert.equal("password" in description,false);
});

test("deployment command is fixed, detached, and shell-quotes the configured path", () => {
  const {config}=loadDeploymentConfig({...configuredEnv,VPS_DEPLOY_PATH:"/opt/milton crm's"});
  const command=buildStartCommand(config,"b".repeat(32));
  assert.match(command,/nohup sh -c/);
  assert.match(command,/COMPOSE_FILE=compose\.yaml \.\/deploy\.sh/);
  assert.match(command,/flock -n/);
  assert.match(command,/milton crm/);
});

test("deployment service starts a remote job and parses its terminal log", async () => {
  const commands=[];
  const service=createVpsDeploymentService({env:configuredEnv,executor:async(_config,command)=>{commands.push(command);return commands.length===1?{code:0,stdout:"started\n",stderr:""}:{code:0,stdout:"success:0\n__MILTON_DEPLOY_LOG__\nDeployment complete\n",stderr:""};}});
  const started=await service.start();
  assert.match(started.jobId,/^[a-f0-9]{32}$/);
  const status=await service.status(started.jobId);
  assert.deepEqual(status,{jobId:started.jobId,state:"success",exitCode:0,output:"Deployment complete\n"});
});

test("host-key fingerprints use the OpenSSH SHA256 format", () => {
  const key=Buffer.from("milton-host-key");
  const expected=`SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/,"")}`;
  assert.equal(fingerprintForHostKey(key),expected);
});

test("unknown deployment jobs are rejected", () => {
  assert.throws(()=>parseStatusOutput("c".repeat(32),"missing\n"),/не найдена/);
});

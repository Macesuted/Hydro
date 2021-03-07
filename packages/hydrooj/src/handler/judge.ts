import { ObjectID } from 'mongodb';
import { JudgeResultBody, Rdoc, TestCase } from '../interface';
import { sleep } from '../utils';
import { Logger } from '../logger';
import * as record from '../model/record';
import * as problem from '../model/problem';
import * as builtin from '../model/builtin';
import * as contest from '../model/contest';
import * as domain from '../model/domain';
import * as task from '../model/task';
import * as bus from '../service/bus';
import {
    Route, Handler, Connection, ConnectionHandler, post, Types,
} from '../service/server';
import storage from '../service/storage';

const logger = new Logger('judge');

async function _postJudge(rdoc: Rdoc) {
    if (typeof rdoc.input === 'string') return;
    const accept = rdoc.status === builtin.STATUS.STATUS_ACCEPTED;
    const updated = await problem.updateStatus(rdoc.domainId, rdoc.pid, rdoc.uid, rdoc._id, rdoc.status);
    if (rdoc.contest) {
        await contest.updateStatus(
            rdoc.domainId, rdoc.contest.tid, rdoc.uid,
            rdoc._id, rdoc.pid, accept, rdoc.score, rdoc.contest.type,
        );
    } else if (updated) await domain.incUserInDomain(rdoc.domainId, rdoc.uid, 'nAccept', 1);
    if (accept && updated) await problem.inc(rdoc.domainId, rdoc.pid, 'nAccept', 1);
}

export async function next(body: JudgeResultBody) {
    if (body.rid) body.rid = new ObjectID(body.rid);
    let rdoc = await record.get(body.domainId, body.rid);
    const $set: Partial<Rdoc> = {};
    const $push: any = {};
    if (body.case) {
        const c: TestCase = {
            memory: body.case.memory,
            time: body.case.time,
            message: body.case.message || '',
            status: body.case.status,
        };
        rdoc.testCases.push(c);
        $push.testCases = c;
    }
    if (body.message) {
        rdoc.judgeTexts.push(body.message);
        $push.judgeTexts = body.message;
    }
    if (body.compilerText) {
        rdoc.compilerTexts.push(body.compilerText);
        $push.compilerTexts = body.compilerText;
    }
    if (body.status) $set.status = body.status;
    if (body.score !== undefined) $set.score = body.score;
    if (body.time !== undefined) $set.time = body.time;
    if (body.memory !== undefined) $set.memory = body.memory;
    if (body.progress !== undefined) $set.progress = body.progress;
    rdoc = await record.update(body.domainId, body.rid, $set, $push);
    bus.boardcast('record/change', rdoc, $set, $push);
}

export async function end(body: JudgeResultBody) {
    if (body.rid) body.rid = new ObjectID(body.rid);
    let rdoc = await record.get(body.domainId, body.rid);
    const $set: Partial<Rdoc> = {};
    const $push: any = {};
    const $unset: any = { progress: '' };
    if (body.message) {
        rdoc.judgeTexts.push(body.message);
        $push.judgeTexts = body.message;
    }
    if (body.compilerText) {
        rdoc.compilerTexts.push(body.compilerText);
        $push.compilerTexts = body.compilerText;
    }
    if (body.status) $set.status = body.status;
    if (body.score !== undefined) $set.score = body.score;
    if (body.time !== undefined) $set.time = body.time;
    if (body.memory !== undefined) $set.memory = body.memory;
    $set.judgeAt = new Date();
    $set.judger = body.judger ?? 1;
    await sleep(100); // Make sure that all 'next' event already triggered
    rdoc = await record.update(body.domainId, body.rid, $set, $push, $unset);
    await _postJudge(rdoc);
    bus.boardcast('record/change', rdoc); // trigger a full update
}

export class JudgeFilesDownloadHandler extends Handler {
    @post('files', Types.Set)
    @post('pid', Types.UnsignedInt)
    async post(domainId: string, files: Set<string>, pid: number) {
        const pdoc = await problem.get(domainId, pid);
        const links = {};
        for (const file of files) {
            // eslint-disable-next-line no-await-in-loop
            links[file] = await storage.signDownloadLink(
                `problem/${pdoc.domainId}/${pdoc.docId}/testdata/${file}`,
                file, false, 'judge',
            );
        }
        this.response.body.links = links;
    }
}

class JudgeConnectionHandler extends ConnectionHandler {
    processing: any = null;

    async prepare() {
        this.newTask();
    }

    async newTask() {
        if (this.processing) return;
        let t;
        while (!t) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
            // eslint-disable-next-line no-await-in-loop
            t = await task.getFirst({ type: 'judge' });
        }
        this.send({ task: t });
        this.processing = t;
        const $set = { status: builtin.STATUS.STATUS_FETCHED };
        const rdoc = await record.update(t.domainId, t.rid, $set, {});
        bus.boardcast('record/change', rdoc, $set, {});
    }

    async message(msg) {
        logger.info('%o', msg);
        if (msg.key === 'next') await next(msg);
        else if (msg.key === 'end') {
            await end({ judger: this.user._id, ...msg });
            this.processing = null;
            await this.newTask();
        }
    }

    async cleanup() {
        if (this.processing) {
            await record.reset(this.processing.domainId, this.processing.rid, false);
            await task.add(this.processing);
        }
    }
}

export async function apply() {
    Route('judge_files_download', '/judge/files', JudgeFilesDownloadHandler, builtin.PRIV.PRIV_JUDGE);
    Connection('judge_conn', '/judge/conn', JudgeConnectionHandler, builtin.PRIV.PRIV_JUDGE);
}

apply.next = next;
apply.end = end;

global.Hydro.handler.judge = apply;

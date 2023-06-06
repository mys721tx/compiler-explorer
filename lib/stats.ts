// Copyright (c) 2023, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import {ExecutionParams, ParsedRequest} from './handlers/compile.js';
import {getHash} from './utils.js';
import {logger} from './logger.js';
import {PropertyGetter} from './properties.interfaces.js';
import {S3Bucket} from './s3-handler.js';
import {StorageClass} from '@aws-sdk/client-s3';

export interface IStatsNoter {
    noteCompilation(request: ParsedRequest);
}

class NullStatsNoter implements IStatsNoter {
    noteCompilation(request: ParsedRequest) {}
}

// A type for storing only compilation information deemed non-identifying; that is, no source or execution options.
// This started out as a `Omit<ParsedRequest, ...>` but really in order to be more useful it needs to be more specialised.
type CompilationRecord = {
    time: string;
    sourceHash: string;
    executionParamsHash: string;
    options: string[];
    filters: Record<string, boolean>;
    bypassCache: boolean;
    // tools: any;
    // libraries: any[];
};

export function filterCompilerOptions(args: string[]): string[] {
    const capturableArg = /^[-/]/;
    const unwantedArg = /^(([-/][iIdD])|(-$))/;
    return args.filter(x => capturableArg.exec(x) && !unwantedArg.exec(x));
}

export function makeSafe(time: Date, request: ParsedRequest): CompilationRecord {
    return {
        time: time.toISOString(),
        sourceHash: getHash(request.source),
        executionParamsHash: getHash(request.executionParameters),
        options: filterCompilerOptions(request.options),
        filters: Object.fromEntries(
            Object.entries(request.filters).filter(value => typeof value[1] === 'boolean'),
        ) as Record<string, boolean>,
        bypassCache: request.bypassCache,
        // todo: tools and libraries once we know what types they are and can guarantee they're json serialisable
    };
}

function makeKey(now: Date): string {
    return `year=${now.getUTCFullYear()}/month=${now.getUTCMonth()}/date=${now.getUTCDate()}/${now.toISOString()}.json`;
}

class StatsNoter implements IStatsNoter {
    private _statsQueue: CompilationRecord[];
    private readonly _flushAfterMs: number;
    private _flushJob: NodeJS.Timeout | undefined;
    private readonly _s3: S3Bucket;
    private readonly _path: string;

    constructor(props: PropertyGetter) {
        this._statsQueue = [];
        this._flushAfterMs = props('compilationStatsNotifierFlushMs', 5 * 60 * 1000);
        this._flushJob = undefined;
        const bucket = props<string>('compilationStatsNotifierS3Bucket');
        this._s3 = new S3Bucket(bucket, props('compilationStatsNotifierS3Region', 'us-east-1'));
        this._path = props('compilationStatsNotifierS3Path', 'compile-stats');
        logger.info(`Flushing stats to ${bucket}/${this._path} every ${this._flushAfterMs}ms`);
    }

    private flush() {
        const toFlush = this._statsQueue;
        this._statsQueue = [];
        if (toFlush) {
            // async write to S3
            this._s3
                .put(makeKey(new Date()), Buffer.from(toFlush.map(x => JSON.stringify(x)).join('\n')), this._path, {
                    redundancy: StorageClass.REDUCED_REDUNDANCY,
                })
                .then(() => {})
                .catch(e => {
                    logger.warn(`Caught exception trying to log compilations to ${makeKey(new Date())}: ${e}`);
                });
        }
        if (this._flushJob !== undefined) {
            clearTimeout(this._flushJob);
            this._flushJob = undefined;
        }
    }

    noteCompilation(request: ParsedRequest) {
        this._statsQueue.push(makeSafe(new Date(), request));
        if (!this._flushJob) this._flushJob = setTimeout(() => this.flush(), this._flushAfterMs);
    }
}

export function createStatsNoter(props: PropertyGetter): IStatsNoter {
    const type = props('compilationStatsNotifier', '');
    switch (type) {
        case 'none':
            return new NullStatsNoter();
        case 'S3':
            return new StatsNoter(props);
    }
    throw new Error(`Unknown stats type '${type}'`);
}
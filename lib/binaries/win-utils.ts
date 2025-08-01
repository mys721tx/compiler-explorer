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

import fs from 'node:fs/promises';
import path from 'node:path';

import {ExecutionOptionsWithEnv} from '../../types/compilation/compilation.interfaces.js';
import {BaseCompiler} from '../base-compiler.js';
import {logger} from '../logger.js';
import * as utils from '../utils.js';

export class WinUtils {
    protected re_dll_name = /dll name: (.*\.dll)/i;
    protected objdumper: string;
    protected exec: any;
    protected alreadyDone: string[];
    protected execOptions: ExecutionOptionsWithEnv;
    protected skippable: string[];

    constructor(exec: typeof BaseCompiler.prototype.exec, objdumper: string, execOptions: ExecutionOptionsWithEnv) {
        this.exec = exec;
        this.objdumper = objdumper;
        this.execOptions = execOptions;
        this.alreadyDone = [];
        this.skippable = ['kernel32.dll', 'ucrtbase.dll'];
    }

    private async find_first_file_in_dirs(paths: string[], filename: string): Promise<string | false> {
        for (const p of paths) {
            const fullpath = path.join(p, filename);
            const found = await utils.fileExists(fullpath);
            if (found) return fullpath;
        }

        return false;
    }

    public async get_dlls_used(executable: string): Promise<string[]> {
        const dlls_used: string[] = [];

        const dump_dlls_used = await this.exec(this.objdumper, ['--private-headers', executable], this.execOptions);

        const paths = this.execOptions.env.PATH.split(path.delimiter);

        const lines = utils.splitLines(dump_dlls_used.stdout);
        for (const line of lines) {
            const match = line.match(this.re_dll_name);
            if (match) {
                const dll_name = match[1];

                if (this.skippable.includes(dll_name.toLowerCase())) continue;
                if (this.alreadyDone.includes(dll_name)) continue;

                logger.debug('looking for ' + dll_name);

                const dll_path = await this.find_first_file_in_dirs(paths, dll_name);
                if (dll_path) {
                    logger.debug('found at ' + dll_path);
                    dlls_used.push(dll_path);
                    this.alreadyDone.push(dll_name);

                    const recursed = await this.get_dlls_used(dll_path);
                    if (recursed.length > 0) {
                        dlls_used.push(...recursed);
                    }
                }
            }
        }

        return dlls_used;
    }
}

export async function copyNeededDlls(
    dirPath: string,
    executableFilename: string,
    execFunction: typeof BaseCompiler.prototype.exec,
    objdumper: string,
    execoptions: ExecutionOptionsWithEnv,
): Promise<void> {
    const winutils = new WinUtils(execFunction, objdumper, execoptions);
    try {
        const dlls = await winutils.get_dlls_used(executableFilename);
        for (const dll of dlls) {
            const infolder = path.join(dirPath, path.basename(dll));
            await fs.copyFile(dll, infolder);
        }
    } catch {
        logger.error(`Error while retreiving or copying dll dependencies of ${executableFilename}`);
    }
}

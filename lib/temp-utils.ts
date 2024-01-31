// Copyright (c) 2024, Compiler Explorer Authors
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

import temp from 'temp';
import os from 'os';

const temp_prefix = 'compiler-explorer-compiler';

export async function newTempDir(): Promise<string> {
    // `temp` caches the os tmp dir on import (which we may change), so here we ensure we use the current os.tmpdir
    // each time.
    return await temp.mkdir({prefix: temp_prefix, dir: os.tmpdir()});
}

function getRegexForTempdir(): RegExp {
    const tmp = os.tmpdir();
    return new RegExp(tmp.replaceAll('/', '\\/') + '\\/' + temp_prefix + '[\\w\\d-.]*\\/');
}

export function maskRootdir(filepath: string): string {
    if (filepath) {
        // todo: make this compatible with local installations etc
        if (process.platform === 'win32') {
            return filepath
                .replace(/^C:\/Users\/[\w\d-.]*\/AppData\/Local\/Temp\/compiler-explorer-compiler[\w\d-.]*\//, '/app/')
                .replace(/^\/app\//, '');
        } else {
            const re = getRegexForTempdir();
            return filepath.replace(re, '/app/').replace(/^\/app\//, '');
        }
    } else {
        return filepath;
    }
}

export function fixRootDirIfNeeded(filepath: string, jailtype: string): string {
    if (filepath && jailtype === 'nsjail') {
        const hasTrailingSlash = filepath.endsWith('/');
        const re = getRegexForTempdir();
        if (hasTrailingSlash) {
            return filepath.replace(re, '/app/');
        } else {
            return (filepath + '/').replace(re, '/app/').replace(/\/$/, '');
        }
    } else {
        return filepath;
    }
}
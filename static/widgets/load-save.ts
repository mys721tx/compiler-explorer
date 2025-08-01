// Copyright (c) 2022, Compiler Explorer Authors
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

import {saveAs} from 'file-saver';
import $ from 'jquery';
import _ from 'underscore';
import {escapeHTML} from '../../shared/common-utils.js';
import {Language} from '../../types/languages.interfaces.js';
import {SourceApiEntry} from '../../types/source.interfaces.js';
import {unwrap, unwrapString} from '../assert.js';
import * as BootstrapUtils from '../bootstrap-utils.js';
import * as history from '../history.js';
import {HistorySource} from '../history.js';
import {localStorage} from '../local.js';
import {Alert} from './alert.js';

type PopulateItem = {name: string; load: () => void; delete?: () => void; overwrite?: () => void};

export class LoadSave {
    private modal: JQuery | null = null;
    private alertSystem: Alert;
    private onLoadCallback: (...args: any) => void = _.identity;
    private editorText = '';
    private extension = '.txt';
    private base: string;
    private currentLanguage: Language | null;

    constructor() {
        this.alertSystem = new Alert();
        this.alertSystem.prefixMessage = 'Load-Saver';
        this.base = window.httpRoot;
        this.fetchBuiltins()
            .then(() => {})
            .catch(() => {});
    }

    public static getLocalFiles(): Record<string, string> {
        return JSON.parse(localStorage.get('files', '{}'));
    }

    public static setLocalFile(name: string, file: string) {
        const files = LoadSave.getLocalFiles();
        files[name] = file;
        localStorage.set('files', JSON.stringify(files));
    }

    public static removeLocalFile(name: string) {
        const files = LoadSave.getLocalFiles();
        if (name in files) {
            delete files[name];
        }
        localStorage.set('files', JSON.stringify(files));
    }

    private async fetchBuiltins(): Promise<SourceApiEntry[]> {
        return new Promise(resolve => {
            $.getJSON(window.location.origin + this.base + 'source/builtin/list', resolve);
        });
    }

    public initializeIfNeeded() {
        if (this.modal === null || this.modal.length === 0) {
            this.modal = $('#load-save');

            this.modal.find('.local-file').on('change', e => this.onLocalFile(e));
            this.modal.find('.save-button').on('click', () => this.onSaveToBrowserStorage());
            this.modal.find('.save-file').on('click', () => this.onSaveToFile());
        }
    }

    private onLoad(data: string, name?: string) {
        this.onLoadCallback(data, name);
    }

    private doLoad(element: SourceApiEntry) {
        $.getJSON(
            window.location.origin + this.base + 'source/builtin/load/' + element.lang + '/' + element.file,
            response => this.onLoad(response.file),
        );
        if (this.modal) {
            BootstrapUtils.hideModal(this.modal);
        }
    }

    private static populate(root: JQuery, list: PopulateItem[]) {
        root.find('li:not(.template)').remove();
        const template = root.find('.template');
        for (const elem of list) {
            const clone = template.clone();
            clone.removeClass('template').appendTo(root).find('a').text(elem.name).on('click', elem.load);
            const deleteButton = clone.find('button.delete');
            if (elem.delete !== undefined) {
                deleteButton.on('click', () => elem.delete?.());
            }
            const overwriteButton = clone.find('button.overwrite');
            if (elem.overwrite !== undefined) {
                overwriteButton.on('click', () => elem.overwrite?.());
            }
        }
    }

    private async populateBuiltins() {
        const builtins = (await this.fetchBuiltins()).filter(entry => this.currentLanguage?.id === entry.lang);
        LoadSave.populate(
            unwrap(this.modal).find('.examples'),
            builtins.map(elem => {
                return {
                    name: elem.name,
                    load: () => this.doLoad(elem),
                };
            }),
        );
    }

    private populateLocalStorage() {
        const files = LoadSave.getLocalFiles();
        const keys = Object.keys(files);

        LoadSave.populate(
            unwrap(this.modal).find('.local-storage'),
            keys.map(name => {
                const data = files[name];
                return {
                    name: name,
                    load: () => {
                        this.onLoad(data);
                        if (this.modal) {
                            BootstrapUtils.hideModal(this.modal);
                        }
                    },
                    delete: () => {
                        this.alertSystem.ask(
                            `Delete ${escapeHTML(name)}?`,
                            `Do you want to delete '${escapeHTML(name)}'?`,
                            {
                                yes: () => {
                                    LoadSave.removeLocalFile(name);
                                    this.populateLocalStorage();
                                },
                            },
                        );
                    },
                    overwrite: () => {
                        this.alertSystem.ask(
                            `Overwrite ${escapeHTML(name)}?`,
                            `Do you want to overwrite '${escapeHTML(name)}'?`,
                            {
                                yes: () => {
                                    LoadSave.setLocalFile(name, this.editorText);
                                    this.populateLocalStorage();
                                },
                            },
                        );
                    },
                };
            }),
        );
    }

    private populateLocalHistory() {
        LoadSave.populate(
            unwrap(this.modal).find('.local-history'),
            history.sources(unwrap(this.currentLanguage).id).map((data: HistorySource) => {
                const dt = new Date(data.dt).toString();
                return {
                    name: dt.replace(/\s\(.*\)/, ''),
                    load: () => {
                        this.onLoad(data.source);
                        if (this.modal) {
                            BootstrapUtils.hideModal(this.modal);
                        }
                    },
                };
            }),
        );
    }

    // From https://developers.google.com/web/updates/2014/08/Easier-ArrayBuffer-String-conversion-with-the-Encoding-API
    private static ab2str(buf: ArrayBuffer) {
        const dataView = new DataView(buf);
        // The TextDecoder interface is documented at http://encoding.spec.whatwg.org/#interface-textdecoder
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(dataView);
    }

    private onLocalFile(event: JQuery.ChangeEvent) {
        const files = event.target.files;
        if (files.length !== 0) {
            const file = files[0];
            const reader = new FileReader();
            reader.onload = () => {
                let result: string;
                if (reader.result instanceof ArrayBuffer) {
                    result = LoadSave.ab2str(reader.result);
                } else {
                    result = reader.result ?? '';
                }
                this.onLoad(result, file.name);
            };
            reader.readAsText(file);
        }
        if (this.modal) {
            BootstrapUtils.hideModal(this.modal);
        }
    }

    public run(onLoad, editorText, currentLanguage: Language) {
        this.initializeIfNeeded();
        this.populateLocalStorage();
        this.setMinimalOptions(editorText, currentLanguage);
        this.populateLocalHistory();
        this.onLoadCallback = onLoad;
        unwrap(this.modal).find('.local-file').attr('accept', currentLanguage.extensions.join(','));
        this.populateBuiltins().then(() => {
            if (this.modal) {
                BootstrapUtils.showModal(this.modal);
            }
        });
    }

    private onSaveToBrowserStorage() {
        const saveNameValue = unwrapString(this.modal?.find('.save-name').val());
        if (!saveNameValue) {
            this.alertSystem.alert('Save name', 'Invalid save name', {isError: true});
            return;
        }
        const name = `${saveNameValue} (${this.currentLanguage?.name ?? ''})`;
        const doneCallback = () => {
            LoadSave.setLocalFile(name, this.editorText);
        };
        if (name in LoadSave.getLocalFiles()) {
            if (this.modal) {
                BootstrapUtils.hideModal(this.modal);
            }
            this.alertSystem.ask(
                'Replace current?',
                `Do you want to replace the existing saved file '${escapeHTML(name)}'?`,
                {yes: doneCallback},
            );
        } else {
            doneCallback();
            if (this.modal) {
                BootstrapUtils.hideModal(this.modal);
            }
        }
    }

    setMinimalOptions(editorText: string, currentLanguage: Language) {
        this.editorText = editorText;
        this.currentLanguage = currentLanguage;
        this.extension = currentLanguage.extensions[0] || '.txt';
    }

    onSaveToFile(fileEditor?: string) {
        try {
            const fileLang = this.currentLanguage?.name ?? '';
            const name = fileLang && fileEditor !== undefined ? fileLang + ' Editor #' + fileEditor + ' ' : '';
            saveAs(
                new Blob([this.editorText], {type: 'text/plain;charset=utf-8'}),
                'Compiler Explorer ' + name + 'Code' + this.extension,
            );
            return true;
        } catch {
            this.alertSystem.notify('Error while saving your code. Use the clipboard instead.', {
                group: 'savelocalerror',
                alertClass: 'notification-error',
                dismissTime: 5000,
            });
            return false;
        }
    }
}

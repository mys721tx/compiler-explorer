// Copyright (c) 2016, Compiler Explorer Authors
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

import {Buffer} from 'buffer';
import $ from 'jquery';
import * as monaco from 'monaco-editor';
import {editor} from 'monaco-editor';
// @ts-ignore
import * as monacoVim from 'monaco-vim';
import TomSelect from 'tom-select';
import _ from 'underscore';
import * as BootstrapUtils from '../bootstrap-utils.js';
import * as colour from '../colour.js';
import * as Components from '../components.js';
import {createDragSource} from '../components.js';
import * as monacoConfig from '../monaco-config.js';
import {options} from '../options.js';
import * as quickFixesHandler from '../quick-fixes-handler.js';
import {SiteSettings} from '../settings.js';
import {Alert} from '../widgets/alert.js';
import * as loadSaveLib from '../widgets/load-save.js';
import '../formatter-registry';
import '../modes/_all';
import {Container} from 'golden-layout';
import type {escape_html} from 'tom-select/dist/types/utils.js';
import {escapeHTML, isString} from '../../shared/common-utils.js';
import {CompilationResult} from '../../types/compilation/compilation.interfaces.js';
import {CompilerInfo} from '../../types/compiler.interfaces.js';
import {Language, LanguageKey} from '../../types/languages.interfaces.js';
import {MessageWithLocation, ResultLine} from '../../types/resultline/resultline.interfaces.js';
import {assert, unwrap} from '../assert.js';
import {Hub} from '../hub.js';
import {Decoration, Motd} from '../motd.interfaces.js';
import {Compiler} from './compiler.js';
import {EditorState} from './editor.interfaces.js';
import {MonacoPaneState, PaneState} from './pane.interfaces.js';
import {MonacoPane} from './pane.js';

import IModelDeltaDecoration = editor.IModelDeltaDecoration;

import {getStaticImage} from '../utils';

const loadSave = new loadSaveLib.LoadSave();
const languages = options.languages;

type ResultLineWithSourcePane = ResultLine & {
    sourcePane: string;
};

export class Editor extends MonacoPane<monaco.editor.IStandaloneCodeEditor, EditorState> {
    private id: number;
    private ourCompilers: Record<string, boolean>;
    private ourExecutors: Record<number, boolean>;
    private httpRoot: string;
    private asmByCompiler: Record<string, ResultLine[] | undefined>;
    private defaultFileByCompiler: Record<number, string>;
    private busyCompilers: Record<number, boolean>;
    private treeCompilers: Record<number, Record<number, boolean> | undefined>;
    private decorations: Record<string, IModelDeltaDecoration[] | undefined>;
    private prevDecorations: string[];
    private extraDecorations?: Decoration[];
    private fadeTimeoutId: NodeJS.Timeout | null;
    private editorSourceByLang: Partial<Record<LanguageKey, string | undefined>>;
    private alertSystem: Alert;
    private filename: string | false;
    private awaitingInitialResults: boolean;
    private revealJumpStack: editor.ICodeEditorViewState[];
    private langKeys: LanguageKey[];
    private legacyReadOnly?: boolean;
    private selectize?: TomSelect;
    private lastChangeEmitted: string | null;
    private languageBtn: JQuery<HTMLElement>;
    public currentLanguage?: Language;
    private waitingForLanguage: boolean;
    private currentCursorPosition: JQuery<HTMLElement>;
    private mouseMoveThrottledFunction?: ((e: monaco.editor.IEditorMouseEvent) => void) & _.Cancelable;
    private cursorSelectionThrottledFunction?: (e: monaco.editor.ICursorSelectionChangedEvent) => void;
    private vimMode: any;
    private vimFlag: JQuery<HTMLElement>;
    private loadSaveButton: JQuery<HTMLElement>;
    private addExecutorButton: JQuery<HTMLElement>;
    private conformanceViewerButton: JQuery<HTMLElement>;
    private cppInsightsButton: JQuery<HTMLElement>;
    private quickBenchButton: JQuery<HTMLElement>;
    private languageInfoButton: JQuery;
    private nothingCtrlSSince?: number;
    private nothingCtrlSTimes?: number;
    private isCpp: editor.IContextKey<boolean>;
    private isClean: editor.IContextKey<boolean>;
    private debouncedEmitChange: (() => void) & _.Cancelable;
    private revealJumpStackHasElementsCtxKey: editor.IContextKey<boolean>;

    constructor(hub: Hub, state: MonacoPaneState & EditorState, container: Container) {
        super(hub, container, state);

        this.alertSystem = new Alert();
        this.alertSystem.prefixMessage = 'Editor #' + this.id;

        if ((state.lang as any) === undefined && Object.keys(languages).length > 0) {
            if (!this.currentLanguage) {
                // Primarily a diagnostic for urls created outside CE. Addresses #4817.
                this.alertSystem.notify('No language specified for editor', {});
            } else {
                this.alertSystem.notify('No language specified for editor, using ' + this.currentLanguage.id, {});
            }
        } else if (!(state.lang in languages) && Object.keys(languages).length > 0) {
            this.alertSystem.alert('State Error', 'Unknown language specified for editor', {isError: true});
        }

        if (this.currentLanguage) this.onLanguageChange(this.currentLanguage.id, true);

        if (state.source !== undefined) {
            this.setSource(state.source);
        } else {
            this.updateEditorCode();
        }

        const startFolded = /^[/*#;]+\s*setup.*/;
        if (state.source?.match(startFolded)) {
            // With reference to https://github.com/Microsoft/monaco-editor/issues/115
            // I tried that and it didn't work, but a delay of 500 seems to "be enough".
            // FIXME: Currently not working - No folding is performed
            setTimeout(() => {
                this.editor.setSelection(new monaco.Selection(1, 1, 1, 1));
                this.editor.focus();
                unwrap(this.editor.getAction('editor.fold')).run();
                //this.editor.clearSelection();
            }, 500);
        }

        if (this.settings.useVim) {
            this.enableVim();
        }

        // We suppress posting changes until the user has stopped typing by:
        // * Using _.debounce() to run emitChange on any key event or change
        //   only after a delay.
        // * Only actually triggering a change if the document text has changed from
        //   the previous emitted.
        this.lastChangeEmitted = null;
        this.onSettingsChange(this.settings);
        // this.editor.on("keydown", () => {
        //     // Not strictly a change; but this suppresses changes until some time
        //     // after the last key down (be it an actual change or a just a cursor
        //     // movement etc).
        //     this.debouncedEmitChange();
        // });
    }

    override initializeCompilerInfo(state: PaneState) {
        this.compilerInfo = {
            compilerId: 0,
            compilerName: '',
            editorId: 0,
            treeId: 0,
        };
    }

    override initializeDefaults(): void {
        this.ourCompilers = {};
        this.ourExecutors = {};
        this.asmByCompiler = {};
        this.defaultFileByCompiler = {};
        this.busyCompilers = {};
        this.treeCompilers = {};

        this.decorations = {};
        this.prevDecorations = [];
        this.extraDecorations = [];

        this.fadeTimeoutId = null;

        this.editorSourceByLang = {};

        this.awaitingInitialResults = false;

        this.revealJumpStack = [];
    }

    override getInitialHTML(): string {
        return $('#codeEditor').html();
    }

    override createEditor(editorRoot: HTMLElement): void {
        this.editor = monaco.editor.create(
            editorRoot,
            monacoConfig.extendConfig(
                {
                    readOnly: !!options.readOnly || this.legacyReadOnly || window.compilerExplorerOptions?.mobileViewer,
                    glyphMargin: !options.embedded,
                },
                this.settings,
            ),
        );

        this.editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF);
    }

    override getPrintName() {
        return 'Source Editor';
    }

    onMotd(motd: Motd): void {
        this.extraDecorations = motd.decorations;
        this.updateExtraDecorations();
    }

    updateExtraDecorations(): void {
        let decorationsDirty = false;
        this.extraDecorations?.forEach(decoration => {
            if (
                decoration.filter &&
                this.currentLanguage?.name &&
                !decoration.filter.includes(this.currentLanguage.name.toLowerCase())
            )
                return;
            const match = this.editor.getModel()?.findNextMatch(
                decoration.regex,
                {
                    column: 1,
                    lineNumber: 1,
                },
                true,
                true,
                null,
                false,
            );

            if (match !== this.decorations[decoration.name]) {
                decorationsDirty = true;
                this.decorations[decoration.name] = match
                    ? [{range: match.range, options: decoration.decoration}]
                    : undefined;
            }
        });

        if (decorationsDirty) this.updateDecorations();
    }

    // If compilerId is undefined, every compiler will be pinged
    maybeEmitChange(force?: boolean, compilerId?: number): void {
        const source = this.getSource();
        if (!force && source === this.lastChangeEmitted) return;

        this.updateExtraDecorations();

        this.lastChangeEmitted = source ?? null;
        this.eventHub.emit(
            'editorChange',
            this.id,
            this.lastChangeEmitted ?? '',
            this.currentLanguage?.id ?? '',
            compilerId,
        );
    }

    // Not using the normal getCurrentState/updateState pattern because the editor does not conform to its own interface
    // (legacy links!)
    override updateState(): void {
        const state = {
            id: this.id,
            source: this.getSource(),
            lang: this.currentLanguage?.id,
            selection: this.selection,
            filename: this.filename,
        };
        this.fontScale.addState(state);
        this.paneRenaming.addState(state);
        this.container.setState(state);
        this.updateButtons();
    }

    setSource(newSource: string): void {
        this.updateSource(newSource);

        if (window.compilerExplorerOptions.mobileViewer) {
            $(this.domRoot.find('.monaco-placeholder textarea')).hide();
        }
    }

    onNewSource(editorId: number, newSource: string): void {
        if (this.id === editorId) {
            this.setSource(newSource);
        }
    }

    getSource(): string | undefined {
        return this.editor.getModel()?.getValue();
    }

    getLanguageFromState(state: MonacoPaneState & EditorState): Language | undefined {
        let newLanguage = languages[this.langKeys[0]];
        this.waitingForLanguage = Boolean(state.source && !state.lang);
        if (this.settings.defaultLanguage && this.settings.defaultLanguage in languages) {
            newLanguage = languages[this.settings.defaultLanguage];
        } else if (this.hub.defaultLangId in languages) {
            // the first time the user visits the site (or particular domain), this.settings might not be set yet
            //  use the hub's default lang if possible
            newLanguage = languages[this.hub.defaultLangId];
        }

        if (state.lang in languages) {
            newLanguage = languages[state.lang];
        } else if (
            this.settings.newEditorLastLang &&
            this.hub.lastOpenedLangId &&
            this.hub.lastOpenedLangId in languages
        ) {
            newLanguage = languages[this.hub.lastOpenedLangId];
        }

        return newLanguage;
    }

    override registerCallbacks(): void {
        this.container.on('shown', this.resize, this);
        this.container.on('open', () => {
            this.eventHub.emit('editorOpen', this.id);
        });
        this.container.layoutManager.on('initialised', () => {
            // Once initialized, let everyone know what text we have.
            this.maybeEmitChange();
            // And maybe ask for a compilation (Will hit the cache most of the time)
            this.requestCompilation();
        });

        this.eventHub.on('treeCompilerEditorIncludeChange', this.onTreeCompilerEditorIncludeChange, this);
        this.eventHub.on('treeCompilerEditorExcludeChange', this.onTreeCompilerEditorExcludeChange, this);
        this.eventHub.on('coloursForEditor', this.onColoursForEditor, this);
        this.eventHub.on('compilerOpen', this.onCompilerOpen, this);
        this.eventHub.on('executorOpen', this.onExecutorOpen, this);
        this.eventHub.on('executorClose', this.onExecutorClose, this);
        this.eventHub.on('compiling', this.onCompiling, this);
        this.eventHub.on('executeResult', this.onExecuteResponse, this);
        this.eventHub.on('selectLine', this.onSelectLine, this);
        this.eventHub.on('editorSetDecoration', this.onEditorSetDecoration, this);
        this.eventHub.on('editorDisplayFlow', this.onEditorDisplayFlow, this);
        this.eventHub.on('editorLinkLine', this.onEditorLinkLine, this);
        this.eventHub.on('conformanceViewOpen', this.onConformanceViewOpen, this);
        this.eventHub.on('conformanceViewClose', this.onConformanceViewClose, this);
        this.eventHub.on('newSource', this.onNewSource, this);
        this.eventHub.on('motd', this.onMotd, this);
        this.eventHub.on('findEditors', this.sendEditor, this);
        this.eventHub.emit('requestMotd');

        this.debouncedEmitChange = _.debounce(() => {
            this.maybeEmitChange();
        }, this.settings.delayAfterChange);

        this.editor.getModel()?.onDidChangeContent(() => {
            this.debouncedEmitChange();
            this.updateState();
        });

        this.mouseMoveThrottledFunction = _.throttle(this.onMouseMove.bind(this), 50);

        this.editor.onMouseMove(e => {
            if (this.mouseMoveThrottledFunction) this.mouseMoveThrottledFunction(e);
        });

        if (window.compilerExplorerOptions.mobileViewer) {
            // workaround for issue with contextmenu not going away when tapping somewhere else on the screen
            this.editor.onDidChangeCursorSelection(() => {
                const contextmenu = $('div.context-view.monaco-menu-container');
                if (contextmenu.css('display') !== 'none') {
                    contextmenu.hide();
                }
            });
        }

        this.cursorSelectionThrottledFunction = _.throttle(this.onDidChangeCursorSelection.bind(this), 500);
        this.editor.onDidChangeCursorSelection(e => {
            if (this.cursorSelectionThrottledFunction) this.cursorSelectionThrottledFunction(e);
        });

        this.editor.onDidFocusEditorText(this.onDidFocusEditorText.bind(this));
        this.editor.onDidBlurEditorText(this.onDidBlurEditorText.bind(this));
        this.editor.onDidChangeCursorPosition(this.onDidChangeCursorPosition.bind(this));

        this.eventHub.on('initialised', this.maybeEmitChange, this);

        $(document).on('keyup.editable', e => {
            if ((e.target as any) === this.domRoot.find('.monaco-placeholder .inputarea')[0]) {
                if (e.which === 27) {
                    this.onEscapeKey();
                } else if (e.which === 45) {
                    this.onInsertKey(e);
                }
            }
        });
    }

    sendEditor(): void {
        this.eventHub.emit('editorOpen', this.id);
    }

    onMouseMove(e: editor.IEditorMouseEvent): void {
        if (e !== null && e.target !== null && this.settings.hoverShowSource && e.target.position !== null) {
            this.clearLinkedLine();
            const pos = e.target.position;
            this.tryPanesLinkLine(pos.lineNumber, pos.column, false);
        }
    }

    override onDidChangeCursorSelection(e: editor.ICursorSelectionChangedEvent): void {
        if (this.awaitingInitialResults) {
            this.selection = e.selection;
            this.updateState();
        }
    }

    onDidChangeCursorPosition(e: editor.ICursorPositionChangedEvent): void {
        this.currentCursorPosition.text('(' + e.position.lineNumber + ', ' + e.position.column + ')');
    }

    onDidFocusEditorText(): void {
        const position = this.editor.getPosition();
        if (position) {
            this.currentCursorPosition.text('(' + position.lineNumber + ', ' + position.column + ')');
        }
        this.currentCursorPosition.show();
    }

    onDidBlurEditorText(): void {
        this.currentCursorPosition.text('');
        this.currentCursorPosition.hide();
    }

    onEscapeKey(): void {
        if ((this.editor as any).vimInUse) {
            const currentState = monacoVim.VimMode.Vim.maybeInitVimState_(this.vimMode);
            if (currentState.insertMode) {
                monacoVim.VimMode.Vim.exitInsertMode(this.vimMode);
            } else if (currentState.visualMode) {
                monacoVim.VimMode.Vim.exitVisualMode(this.vimMode, false);
            }
        }
    }

    onInsertKey(event: JQuery.TriggeredEvent<Document, undefined, Document, Document>): void {
        if ((this.editor as any).vimInUse) {
            const currentState = monacoVim.VimMode.Vim.maybeInitVimState_(this.vimMode);
            if (!currentState.insertMode) {
                const insertEvent = {
                    preventDefault: event.preventDefault,
                    stopPropagation: event.stopPropagation,
                    browserEvent: {
                        key: 'i',
                        defaultPrevented: false,
                    },
                    keyCode: 39,
                };
                this.vimMode.handleKeyDown(insertEvent);
            }
        }
    }

    enableVim(): void {
        const statusElem = this.domRoot.find('.v-status')[0];
        const vimMode = monacoVim.initVimMode(this.editor, statusElem);
        this.vimMode = vimMode;
        this.vimFlag.prop('class', 'btn btn-info');
        (this.editor as any).vimInUse = true;
    }

    disableVim(): void {
        this.vimMode.dispose();
        this.domRoot.find('.v-status').html('');
        this.vimFlag.prop('class', 'btn btn-light');
        (this.editor as any).vimInUse = false;
    }

    override initializeGlobalDependentProperties(): void {
        super.initializeGlobalDependentProperties();

        this.httpRoot = window.httpRoot;
        this.langKeys = Object.keys(languages) as LanguageKey[];
    }

    override initializeStateDependentProperties(state: MonacoPaneState & EditorState): void {
        super.initializeStateDependentProperties(state);

        this.id = state.id || this.hub.nextEditorId();

        this.filename = state.filename ?? false;
        this.selection = state.selection;
        this.legacyReadOnly = state.options && !!state.options.readOnly;

        this.currentLanguage = this.getLanguageFromState(state);
        if (!this.currentLanguage) {
            //this.currentLanguage = options.defaultCompiler;
        }
    }

    override registerButtons(state: MonacoPaneState & EditorState): void {
        super.registerButtons(state);

        this.topBar = this.domRoot.find('.top-bar');
        this.hideable = this.domRoot.find('.hideable');

        this.loadSaveButton = this.domRoot.find('.load-save');
        const paneAdderDropdown = this.domRoot.find('.add-pane');
        const addCompilerButton = this.domRoot.find('.btn.add-compiler');
        this.addExecutorButton = this.domRoot.find('.btn.add-executor');
        this.conformanceViewerButton = this.domRoot.find('.btn.conformance');
        const addEditorButton = this.domRoot.find('.btn.add-editor');
        const toggleVimButton = this.domRoot.find('.vim-flag');
        this.vimFlag = this.domRoot.find('.vim-flag');
        toggleVimButton.on('click', () => {
            if ((this.editor as any).vimInUse) {
                this.disableVim();
            } else {
                this.enableVim();
            }
        });

        // Ensure that the button is disabled if we don't have anything to select
        // Note that is might be disabled for other reasons beforehand
        if (this.langKeys.length <= 1) {
            this.languageBtn.prop('disabled', true);
        }

        const usableLanguages = Object.values(languages).filter(language => {
            return this.hub.compilerService.getCompilersForLang(language.id);
        });

        this.languageInfoButton = this.domRoot.find('.language-info');
        BootstrapUtils.initPopover(this.languageInfoButton);
        this.languageBtn = this.domRoot.find('.change-language');
        const changeLanguageButton = this.languageBtn[0];
        assert(changeLanguageButton instanceof HTMLSelectElement);
        this.selectize = new TomSelect(changeLanguageButton, {
            sortField: 'name',
            valueField: 'id',
            labelField: 'name',
            searchField: ['name'],
            placeholder: '🔍 Select a language...',
            options: [...usableLanguages],
            items: this.currentLanguage?.id ? [this.currentLanguage.id] : [],
            dropdownParent: 'body',
            plugins: ['dropdown_input'],
            maxOptions: 1000,
            onChange: this.onLanguageChange.bind(this) as (x: any) => void,
            closeAfterSelect: true,
            render: {
                option: this.renderSelectizeOption.bind(this),
                item: this.renderSelectizeItem.bind(this),
            },
        });
        this.selectize.on('dropdown_close', () => {
            // scroll back to the selection on the next open
            const selection = unwrap(this.selectize).getOption(this.currentLanguage?.id ?? '');
            unwrap(this.selectize).setActiveOption(selection);
        });

        // NB a new compilerConfig needs to be created every time; else the state is shared
        // between all compilers created this way. That leads to some nasty-to-find state
        // bugs e.g. https://github.com/compiler-explorer/compiler-explorer/issues/225
        const getCompilerConfig = () => {
            return Components.getCompiler(this.id, this.currentLanguage?.id ?? '');
        };

        const getExecutorConfig = () => {
            return Components.getExecutor(this.id, this.currentLanguage?.id ?? '');
        };

        const getConformanceConfig = () => {
            // TODO: this doesn't pass any treeid introduced by #3360
            return Components.getConformanceView(this.id, 0, this.getSource() ?? '', this.currentLanguage?.id ?? '');
        };

        const getEditorConfig = () => {
            if (this.currentLanguage) {
                return Components.getEditor(this.currentLanguage.id);
            }
            // TODO(jeremy-rifkin): Can this.settings.defaultLanguage really be undefined?
            return Components.getEditor(unwrap(this.settings.defaultLanguage));
        };

        const addPaneOpener = (dragSource: JQuery<HTMLElement>, dragConfig) => {
            createDragSource(this.container.layoutManager, dragSource, () => dragConfig()).on('dragStart', () => {
                const dropdown = BootstrapUtils.getDropdownInstance(paneAdderDropdown);
                if (dropdown) {
                    dropdown.toggle();
                }
            });

            dragSource.on('click', () => {
                const insertPoint =
                    this.hub.findParentRowOrColumn(this.container.parent) ||
                    this.container.layoutManager.root.contentItems[0];
                insertPoint.addChild(dragConfig);
            });
        };

        addPaneOpener(addCompilerButton, getCompilerConfig);
        addPaneOpener(this.addExecutorButton, getExecutorConfig);
        addPaneOpener(this.conformanceViewerButton, getConformanceConfig);
        addPaneOpener(addEditorButton, getEditorConfig);

        this.initLoadSaver();
        $(this.domRoot).on('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && String.fromCharCode(event.which).toLowerCase() === 's') {
                this.handleCtrlS(event);
            }
        });

        if (options.thirdPartyIntegrationEnabled) {
            this.cppInsightsButton = this.domRoot.find('.open-in-cppinsights');
            this.cppInsightsButton.on('mousedown', () => {
                this.updateOpenInCppInsights();
            });

            this.quickBenchButton = this.domRoot.find('.open-in-quickbench');
            this.quickBenchButton.on('mousedown', () => {
                this.updateOpenInQuickBench();
            });
        }

        this.currentCursorPosition = this.domRoot.find('.currentCursorPosition');
        this.currentCursorPosition.hide();
    }

    handleCtrlS(event: JQuery.KeyDownEvent<HTMLElement, undefined, HTMLElement, HTMLElement>): void {
        event.preventDefault();
        if (this.settings.enableCtrlStree && this.hub.hasTree()) {
            const trees = this.hub.trees;
            // todo: change when multiple trees are used
            if (trees && trees.length > 0) {
                trees[0].multifileService.includeByEditorId(this.id).then(() => {
                    trees[0].refresh();
                });
            }
        } else {
            if (this.settings.enableCtrlS === 'true') {
                if (this.currentLanguage) loadSave.setMinimalOptions(this.getSource() ?? '', this.currentLanguage);
                if (!loadSave.onSaveToFile(this.id.toString())) {
                    this.showLoadSaver();
                }
            } else if (this.settings.enableCtrlS === '2') {
                this.runFormatDocumentAction();
            } else if (this.settings.enableCtrlS === '3') {
                this.handleCtrlSDoNothing();
            }
        }
    }

    handleCtrlSDoNothing(): void {
        if (this.nothingCtrlSTimes === undefined) {
            this.nothingCtrlSTimes = 0;
            this.nothingCtrlSSince = Date.now();
        } else {
            if (Date.now() - (this.nothingCtrlSSince ?? 0) > 5000) {
                this.nothingCtrlSTimes = undefined;
            } else if (this.nothingCtrlSTimes === 4) {
                const element = this.domRoot.find('.ctrlSNothing');
                element.show(100);
                setTimeout(() => {
                    element.hide();
                }, 2000);
                this.nothingCtrlSTimes = undefined;
            } else {
                this.nothingCtrlSTimes++;
            }
        }
    }

    updateButtons(): void {
        if (options.thirdPartyIntegrationEnabled) {
            if (this.currentLanguage?.id === 'c++') {
                this.cppInsightsButton.show();
                this.quickBenchButton.show();
            } else {
                this.cppInsightsButton.hide();
                this.quickBenchButton.hide();
            }
        }

        this.addExecutorButton.prop('disabled', !this.currentLanguage?.supportsExecute);
    }

    b64UTFEncode(str: string): string {
        return Buffer.from(
            encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, v) => {
                return String.fromCharCode(Number.parseInt(v, 16));
            }),
        ).toString('base64');
    }

    asciiEncodeJsonText(json: string): string {
        return json.replace(/[\u007F-\uFFFF]/g, chr => {
            // json unicode escapes must always be 4 characters long, so pad with leading zeros
            return '\\u' + ('0000' + chr.charCodeAt(0).toString(16)).substring(-4);
        });
    }

    getCompilerStates(): any[] {
        const states: any[] = [];

        for (const compilerIdStr of Object.keys(this.ourCompilers)) {
            const compilerId = Number.parseInt(compilerIdStr);

            const glCompiler: Compiler | undefined = _.find(
                this.container.layoutManager.root.getComponentsByName('compiler'),
                c => c.id === compilerId,
            );

            if (glCompiler) {
                const state = glCompiler.getCurrentState();
                states.push(state);
            }
        }

        return states;
    }

    updateOpenInCppInsights(): void {
        if (options.thirdPartyIntegrationEnabled) {
            let cppStd = 'cpp2a';

            const compilers = this.getCompilerStates();
            compilers.forEach(compiler => {
                if (compiler.options.indexOf('-std=c++11') !== -1 || compiler.options.indexOf('-std=gnu++11') !== -1) {
                    cppStd = 'cpp11';
                } else if (
                    compiler.options.indexOf('-std=c++14') !== -1 ||
                    compiler.options.indexOf('-std=gnu++14') !== -1
                ) {
                    cppStd = 'cpp14';
                } else if (
                    compiler.options.indexOf('-std=c++17') !== -1 ||
                    compiler.options.indexOf('-std=gnu++17') !== -1
                ) {
                    cppStd = 'cpp17';
                } else if (
                    compiler.options.indexOf('-std=c++2a') !== -1 ||
                    compiler.options.indexOf('-std=gnu++2a') !== -1
                ) {
                    cppStd = 'cpp2a';
                } else if (compiler.options.indexOf('-std=c++98') !== -1) {
                    cppStd = 'cpp98';
                }
            });

            const maxURL = 8177; // apache's default maximum url length
            const maxCode = maxURL - ('/lnk?code=&std=' + cppStd + '&rev=1.0').length;
            let codeData = this.b64UTFEncode(this.getSource() ?? '');
            if (codeData.length > maxCode) {
                codeData = this.b64UTFEncode('/** Source too long to fit in a URL */\n');
            }

            const link = 'https://cppinsights.io/lnk?code=' + codeData + '&std=' + cppStd + '&rev=1.0';

            this.cppInsightsButton.attr('href', link);
        }
    }

    cleanupSemVer(semver: string): string | null {
        if (semver) {
            const semverStr = semver.toString();
            if (semverStr !== '' && !semverStr.includes('(')) {
                const vercomps = semverStr.split('.');
                return vercomps[0] + '.' + (vercomps[1] ? vercomps[1] : '0');
            }
        }

        return null;
    }

    updateOpenInQuickBench(): void {
        if (options.thirdPartyIntegrationEnabled) {
            type QuickBenchState = {
                text?: string;
                compiler?: string;
                optim?: string;
                cppVersion?: string;
                lib?: string;
            };

            const quickBenchState: QuickBenchState = {
                text: this.getSource(),
            };

            const compilers = this.getCompilerStates();

            compilers.forEach(compiler => {
                let knownCompiler = false;

                const compilerExtInfo = unwrap(
                    this.hub.compilerService.findCompiler(this.currentLanguage?.id ?? '', compiler.compiler),
                );
                const semver = this.cleanupSemVer(compilerExtInfo.semver);
                let groupOrName = compilerExtInfo.baseName || compilerExtInfo.groupName || compilerExtInfo.name;
                if (semver && groupOrName) {
                    groupOrName = groupOrName.toLowerCase();
                    if (groupOrName.includes('gcc')) {
                        quickBenchState.compiler = 'gcc-' + semver;
                        knownCompiler = true;
                    } else if (groupOrName.includes('clang')) {
                        quickBenchState.compiler = 'clang-' + semver;
                        knownCompiler = true;
                    }
                }

                if (knownCompiler) {
                    const match = compiler.options.match(/-(O([0-3sg]|fast))/);
                    if (match !== null) {
                        if (match[2] === 'fast') {
                            quickBenchState.optim = 'F';
                        } else {
                            quickBenchState.optim = match[2].toUpperCase();
                        }
                    }

                    if (
                        compiler.options.indexOf('-std=c++11') !== -1 ||
                        compiler.options.indexOf('-std=gnu++11') !== -1
                    ) {
                        quickBenchState.cppVersion = '11';
                    } else if (
                        compiler.options.indexOf('-std=c++14') !== -1 ||
                        compiler.options.indexOf('-std=gnu++14') !== -1
                    ) {
                        quickBenchState.cppVersion = '14';
                    } else if (
                        compiler.options.indexOf('-std=c++17') !== -1 ||
                        compiler.options.indexOf('-std=gnu++17') !== -1
                    ) {
                        quickBenchState.cppVersion = '17';
                    } else if (
                        compiler.options.indexOf('-std=c++2a') !== -1 ||
                        compiler.options.indexOf('-std=gnu++2a') !== -1
                    ) {
                        quickBenchState.cppVersion = '20';
                    }

                    if (compiler.options.indexOf('-stdlib=libc++') !== -1) {
                        quickBenchState.lib = 'llvm';
                    }
                }
            });

            const link =
                'https://quick-bench.com/#' +
                Buffer.from(this.asciiEncodeJsonText(JSON.stringify(quickBenchState))).toString('base64');
            this.quickBenchButton.attr('href', link);
        }
    }

    changeLanguage(newLang: string): void {
        if (!this.selectize) {
            // In some initialization flows we get here before creating this.selectize
            setTimeout(() => this.changeLanguage(newLang), 0);
        } else {
            if (newLang === 'cmake') {
                this.selectize.addOption(unwrap(languages.cmake));
            }
            this.selectize.setValue(newLang);
        }
    }

    clearLinkedLine() {
        this.decorations.linkedCode = [];
        this.updateDecorations();
    }

    tryPanesLinkLine(thisLineNumber: number, column: number, reveal: boolean): void {
        const selectedToken = this.getTokenSpan(thisLineNumber, column);
        for (const compilerId of Object.keys(this.asmByCompiler)) {
            this.eventHub.emit(
                'panesLinkLine',
                Number(compilerId),
                thisLineNumber,
                selectedToken.colBegin,
                selectedToken.colEnd,
                reveal,
                this.getPaneName(),
                this.id,
            );
        }
    }

    requestCompilation(): void {
        this.eventHub.emit('requestCompilation', this.id, false);
        if (this.settings.formatOnCompile) {
            this.runFormatDocumentAction();
        }

        this.hub.trees.forEach(tree => {
            if (tree.multifileService.isEditorPartOfProject(this.id)) {
                this.eventHub.emit('requestCompilation', this.id, tree.id);
            }
        });
    }

    override registerEditorActions(): void {
        this.editor.addAction({
            id: 'compile',
            label: 'Compile',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
            keybindingContext: undefined,
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1.5,
            run: () => {
                // This change request is mostly superfluous
                this.maybeEmitChange();
                this.requestCompilation();
            },
        });

        // Same check from upstream
        // https://github.com/microsoft/vscode/blob/1052813be23485fd9c17ac77b517241479c21142/src/vs/editor/contrib/clipboard/browser/clipboard.ts#L27-L30
        // Modified in regards to #5142
        const supportsPaste =
            typeof navigator.clipboard === 'undefined'
                ? false
                : navigator.userAgent.includes('Firefox')
                  ? 'readText' in navigator.clipboard
                  : true;
        if (!supportsPaste) {
            this.editor.addAction({
                id: 'firefoxDoesntSupportPaste',
                label: "Firefox doesn't support context-menu paste",
                contextMenuGroupId: '9_cutcopypaste',
                run: () => {},
            });
        }

        this.revealJumpStackHasElementsCtxKey = this.editor.createContextKey('hasRevealJumpStackElements', false);

        this.editor.addAction({
            id: 'returnfromreveal',
            label: 'Return from reveal jump',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1.4,
            precondition: 'hasRevealJumpStackElements',
            run: () => {
                this.popAndRevealJump();
            },
        });

        this.editor.addAction({
            id: 'toggleCompileOnChange',
            label: 'Toggle compile on change',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
            keybindingContext: undefined,
            run: () => {
                this.eventHub.emit('modifySettings', {
                    compileOnChange: !this.settings.compileOnChange,
                });
                this.alertSystem.notify(
                    'Compile on change has been toggled ' + (this.settings.compileOnChange ? 'ON' : 'OFF'),
                    {
                        group: 'togglecompile',
                        alertClass: this.settings.compileOnChange ? 'notification-on' : 'notification-off',
                        dismissTime: 3000,
                    },
                );
            },
        });

        this.editor.addAction({
            id: 'toggleColourisation',
            label: 'Toggle colourisation',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.F1],
            keybindingContext: undefined,
            run: () => {
                this.eventHub.emit('modifySettings', {
                    colouriseAsm: !this.settings.colouriseAsm,
                });
            },
        });

        this.editor.addAction({
            id: 'viewasm',
            label: 'Reveal linked code',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
            keybindingContext: undefined,
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1.5,
            run: ed => {
                const pos = ed.getPosition();
                if (pos != null) {
                    this.tryPanesLinkLine(pos.lineNumber, pos.column, true);
                }
            },
        });

        this.isCpp = this.editor.createContextKey('isCpp', true);
        this.isCpp.set(this.currentLanguage?.id === 'c++');

        this.isClean = this.editor.createContextKey('isClean', true);
        this.isClean.set(this.currentLanguage?.id === 'clean');

        this.editor.addAction({
            id: 'cpprefsearch',
            label: 'Search on Cppreference',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8],
            keybindingContext: undefined,
            contextMenuGroupId: 'help',
            contextMenuOrder: 1.5,
            precondition: 'isCpp',
            run: this.searchOnCppreference.bind(this),
        });

        this.editor.addAction({
            id: 'clooglesearch',
            label: 'Search on Cloogle',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8],
            keybindingContext: undefined,
            contextMenuGroupId: 'help',
            contextMenuOrder: 1.5,
            precondition: 'isClean',
            run: this.searchOnCloogle.bind(this),
        });

        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F9, () => {
            this.runFormatDocumentAction();
        });

        this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD, () => {
            unwrap(this.editor.getAction('editor.action.duplicateSelection')).run();
        });
    }

    runFormatDocumentAction(): void {
        unwrap(this.editor.getAction('editor.action.formatDocument')).run();
    }

    searchOnCppreference(ed: monaco.editor.ICodeEditor): void {
        const pos = ed.getPosition();
        if (!pos || !ed.getModel()) return;
        const word = ed.getModel()?.getWordAtPosition(pos);
        if (!word || !word.word) return;
        const preferredLanguage = this.getPreferredLanguageTag();
        // This list comes from the footer of the page
        const cpprefLangs = ['ar', 'cs', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'zh'];
        // If navigator.languages is supported, we could be a bit more clever and look for a match there too
        let langTag = 'en';
        if (cpprefLangs.includes(preferredLanguage)) {
            langTag = preferredLanguage;
        }
        const url = 'https://' + langTag + '.cppreference.com/mwiki/index.php?search=' + encodeURIComponent(word.word);
        window.open(url, '_blank', 'noopener');
    }

    searchOnCloogle(ed: monaco.editor.ICodeEditor): void {
        const pos = ed.getPosition();
        if (!pos || !ed.getModel()) return;
        const word = ed.getModel()?.getWordAtPosition(pos);
        if (!word || !word.word) return;
        const url = 'https://cloogle.org/#' + encodeURIComponent(word.word);
        window.open(url, '_blank', 'noopener');
    }

    getPreferredLanguageTag(): string {
        let result = 'en';
        let lang = 'en';
        if (navigator) {
            if (navigator.languages?.length) {
                lang = navigator.languages[0];
            } else if (navigator.language) {
                lang = navigator.language;
            }
        }
        // navigator.language[s] is supposed to return strings, but hey, you never know
        if (lang !== result && isString(lang)) {
            const primaryLanguageSubtagIdx = lang.indexOf('-');
            result = lang.substring(0, primaryLanguageSubtagIdx).toLowerCase();
        }
        return result;
    }

    doesMatchEditor(otherSource?: string): boolean {
        return otherSource === this.getSource();
    }

    confirmOverwrite(yes: () => void): void {
        this.alertSystem.ask(
            'Changes were made to the code',
            'Changes were made to the code while it was being processed. Overwrite changes?',
            {yes: yes, no: undefined},
        );
    }

    updateSource(newSource: string): void {
        // Create something that looks like an edit operation for the whole text
        const operation = {
            range: this.editor.getModel()?.getFullModelRange(),
            forceMoveMarkers: true,
            text: newSource,
        };
        const nullFn = () => {
            return null;
        };

        const viewState = this.editor.saveViewState();
        // Add an undo stop so we don't go back further than expected
        this.editor.pushUndoStop();
        // Apply de edit. Note that we lose cursor position, but I've not found a better alternative yet
        // @ts-expect-error: See above comment maybe
        this.editor.getModel()?.pushEditOperations(viewState?.cursorState ?? null, [operation], nullFn);
        this.numberUsedLines();

        if (!this.awaitingInitialResults) {
            if (this.selection) {
                /*
                 * this setTimeout is a really crap workaround to fix #2150
                 * the TL;DR; is that we reach this point *before* GL has laid
                 * out the window, so we have no height
                 *
                 * If we revealLinesInCenter at this point the editor "does the right thing"
                 * and scrolls itself all the way to the line we requested.
                 *
                 * Unfortunately the editor thinks it is very small, so the "center"
                 * is the first line, and when the editor does resize eventually things are off.
                 *
                 * The workaround is to just delay things "long enough"
                 *
                 * This is bad and I feel bad.
                 */
                setTimeout(() => {
                    if (this.selection) {
                        this.editor.setSelection(this.selection);
                        this.editor.revealLinesInCenter(this.selection.startLineNumber, this.selection.endLineNumber);
                    }
                }, 500);
            }
            this.awaitingInitialResults = true;
        }
    }

    formatCurrentText(): void {
        const previousSource = this.getSource();
        const lang = this.currentLanguage;

        if (!Object.prototype.hasOwnProperty.call(lang, 'formatter')) {
            this.alertSystem.notify('This language does not support in-editor formatting', {
                group: 'formatting',
                alertClass: 'notification-error',
            });
            return;
        }

        $.ajax({
            type: 'POST',
            url: window.location.origin + this.httpRoot + 'api/format/' + lang?.formatter,
            dataType: 'json', // Expected
            contentType: 'application/json', // Sent
            data: JSON.stringify({
                source: previousSource,
                base: this.settings.formatBase,
            }),
            success: result => {
                if (result.exit === 0) {
                    if (this.doesMatchEditor(previousSource)) {
                        this.updateSource(result.answer);
                    } else {
                        this.confirmOverwrite(this.updateSource.bind(this, result.answer));
                    }
                } else {
                    // Ops, the formatter itself failed!
                    this.alertSystem.notify('We encountered an error formatting your code: ' + result.answer, {
                        group: 'formatting',
                        alertClass: 'notification-error',
                    });
                }
            },
            error: (xhr, e_status, error) => {
                // Hopefully we have not exploded!
                if (xhr.responseText) {
                    try {
                        const res = JSON.parse(xhr.responseText);
                        error = res.answer || error;
                    } catch {
                        // continue regardless of error
                    }
                }
                error = error || 'Unknown error';
                this.alertSystem.notify('We ran into some issues while formatting your code: ' + error, {
                    group: 'formatting',
                    alertClass: 'notification-error',
                });
            },
            cache: true,
        });
    }

    override resize(): void {
        super.resize();

        // Only update the options if needed
        if (this.settings.wordWrap) {
            // super.resize is going to _.defer, so we also _.defer to get those updates
            // This fixes https://github.com/compiler-explorer/compiler-explorer/issues/4486
            _.defer(() => {
                this.editor.updateOptions({
                    wordWrapColumn: this.editor.getLayoutInfo().viewportColumn,
                });
            });
        }
    }

    override onSettingsChange(newSettings: SiteSettings): void {
        const before = this.settings;
        const after = newSettings;
        this.settings = {...newSettings};

        this.editor.updateOptions({
            autoIndent: this.settings.autoIndent ? 'advanced' : 'none',
            autoClosingBrackets: this.settings.autoCloseBrackets ? 'always' : 'never',
            autoClosingQuotes: this.settings.autoCloseQuotes ? 'always' : 'never',
            autoSurround: this.settings.autoSurround ? 'languageDefined' : 'never',
            // once https://github.com/microsoft/monaco-editor/issues/3013 is fixed, we should use this:
            // bracketPairColorization: {
            //     enabled: this.settings.colouriseBrackets,
            //     independentColorPoolPerBracketType: true,
            // },
            // @ts-ignore once the bug is fixed we can remove this suppression
            'bracketPairColorization.enabled': this.settings.colouriseBrackets,
            useVim: this.settings.useVim,
            quickSuggestions: this.settings.showQuickSuggestions,
            contextmenu: this.settings.useCustomContextMenu,
            minimap: {
                enabled: this.settings.showMinimap && !options.embedded,
            },
            fontFamily: this.settings.editorsFFont,
            fontLigatures: this.settings.editorsFLigatures,
            wordWrap: this.settings.wordWrap ? 'bounded' : 'off',
            wordWrapColumn: this.editor.getLayoutInfo().viewportColumn, // Ensure the column count is up to date
        });

        if (before.hoverShowSource && !after.hoverShowSource) {
            this.onEditorSetDecoration(this.id, -1, false);
        }

        if (after.useVim && !before.useVim) {
            this.enableVim();
        } else if (!after.useVim && before.useVim) {
            this.disableVim();
        }

        this.editor.getModel()?.updateOptions({
            tabSize: this.settings.tabWidth,
            indentSize: this.settings.tabWidth,
            insertSpaces: this.settings.useSpaces,
        });

        this.numberUsedLines();
    }

    numberUsedLines(): void {
        if (_.any(this.busyCompilers)) return;

        if (!this.settings.colouriseAsm) {
            this.updateColours([]);
            return;
        }

        if (this.hub.hasTree()) {
            return;
        }

        const result: Record<number, number> = {};
        // First, note all lines used.
        for (const [compilerId, asm] of Object.entries(this.asmByCompiler)) {
            asm?.forEach(asmLine => {
                let foundInTrees = false;

                for (const [treeId, compilerIds] of Object.entries(this.treeCompilers)) {
                    if (compilerIds?.[compilerId]) {
                        const tree = this.hub.getTreeById(Number(treeId));
                        if (tree) {
                            const defaultFile = this.defaultFileByCompiler[compilerId];
                            foundInTrees = true;

                            if (asmLine.source && asmLine.source.line > 0) {
                                const sourcefilename = asmLine.source.file ? asmLine.source.file : defaultFile;
                                if (this.id === tree.multifileService.getEditorIdByFilename(sourcefilename)) {
                                    result[asmLine.source.line - 1] = 1;
                                }
                            }
                        }
                    }
                }

                if (!foundInTrees) {
                    if (
                        asmLine.source &&
                        (asmLine.source.file === null || asmLine.source.mainsource) &&
                        asmLine.source.line > 0
                    ) {
                        result[asmLine.source.line - 1] = 1;
                    }
                }
            });
        }
        // Now assign an ordinal to each used line.
        let ordinal = 0;
        Object.keys(result).forEach(k => {
            result[k] = ordinal++;
        });

        this.updateColours(result);
    }

    updateColours(colours: Record<number, number>) {
        colour.applyColours(colours, this.settings.colourScheme, this.editorDecorations);
        this.eventHub.emit('colours', this.id, colours, this.settings.colourScheme);
    }

    onCompilerOpen(compilerId: number, editorId: number, treeId: number | boolean): void {
        if (editorId === this.id) {
            // On any compiler open, rebroadcast our state in case they need to know it.
            if (this.waitingForLanguage) {
                const glCompiler = _.find(
                    this.container.layoutManager.root.getComponentsByName('compiler'),
                    c => c.id === compilerId,
                );
                if (glCompiler) {
                    const selected = options.compilers.find(compiler => {
                        return compiler.id === glCompiler.originalCompilerId;
                    });
                    if (selected) {
                        this.changeLanguage(selected.lang);
                    }
                }
            }

            if (typeof treeId === 'number' && treeId > 0) {
                if (!this.treeCompilers[treeId]) {
                    this.treeCompilers[treeId] = {};
                }

                unwrap(this.treeCompilers[treeId])[compilerId] = true;
            }
            this.ourCompilers[compilerId] = true;

            if (!treeId) {
                this.maybeEmitChange(true, compilerId);
            }
        }
    }

    onTreeCompilerEditorIncludeChange(treeId: number, editorId: number, compilerId: number): void {
        if (this.id === editorId) {
            this.onCompilerOpen(compilerId, editorId, treeId);
        }
    }

    onTreeCompilerEditorExcludeChange(treeId: number, editorId: number, compilerId: number): void {
        if (this.id === editorId) {
            this.onCompilerClose(compilerId);
        }
    }

    onColoursForEditor(editorId: number, colours: Record<number, number>, scheme: string): void {
        if (this.id === editorId) {
            colour.applyColours(colours, scheme, this.editorDecorations);
        }
    }

    onExecutorOpen(executorId: number, editorId: boolean | number): void {
        if (editorId === this.id) {
            this.maybeEmitChange(true);
            this.ourExecutors[executorId] = true;
        }
    }

    override onCompilerClose(compilerId: number): void {
        /*if (this.treeCompilers[treeId]) {
            delete this.treeCompilers[treeId][compilerId];
        }*/

        if (this.ourCompilers[compilerId]) {
            const model = this.editor.getModel();
            if (model) monaco.editor.setModelMarkers(model, String(compilerId), []);
            delete this.asmByCompiler[compilerId];
            delete this.busyCompilers[compilerId];
            delete this.ourCompilers[compilerId];
            delete this.defaultFileByCompiler[compilerId];
            this.numberUsedLines();
        }
    }

    onExecutorClose(id: number): void {
        if (this.ourExecutors[id]) {
            delete this.ourExecutors[id];
            const model = this.editor.getModel();
            if (model) monaco.editor.setModelMarkers(model, 'Executor ' + id, []);
        }
    }

    onCompiling(compilerId: number): void {
        if (!this.ourCompilers[compilerId]) return;
        this.busyCompilers[compilerId] = true;
    }

    addSource(arr: ResultLine[] | undefined, sourcePane: string): ResultLineWithSourcePane[] {
        if (arr) {
            const newArr: ResultLineWithSourcePane[] = arr.map(element => {
                return {
                    sourcePane: sourcePane,
                    ...element,
                };
            });

            return newArr;
        }
        return [];
    }

    getAllOutputAndErrors(
        result: CompilationResult,
        compilerName: string,
        compilerId: number | string,
    ): (ResultLine & {sourcePane: string})[] {
        const compilerTitle = compilerName + ' #' + compilerId;
        let all = this.addSource(result.stdout, compilerTitle);

        if (result.buildsteps) {
            _.each(result.buildsteps, step => {
                all = all.concat(this.addSource(step.stdout, compilerTitle));
                all = all.concat(this.addSource(step.stderr, compilerTitle));
            });
        }
        if (result.tools) {
            _.each(result.tools, tool => {
                all = all.concat(this.addSource(tool.stdout, tool.name + ' #' + compilerId));
                all = all.concat(this.addSource(tool.stderr, tool.name + ' #' + compilerId));
            });
        }
        all = all.concat(this.addSource(result.stderr, compilerTitle));

        return all;
    }

    collectOutputWidgets(output: (ResultLine & {sourcePane: string})[]): {
        fixes: monaco.languages.CodeAction[];
        widgets: editor.IMarkerData[];
    } {
        let fixes: monaco.languages.CodeAction[] = [];
        const editorModel = this.editor.getModel();
        const widgets = _.compact(
            output.map(obj => {
                if (!obj.tag) return;

                const trees = this.hub.trees;
                if (trees && trees.length > 0) {
                    if (obj.tag.file) {
                        if (this.id !== trees[0].multifileService.getEditorIdByFilename(obj.tag.file)) {
                            return;
                        }
                    } else {
                        if (this.id !== trees[0].multifileService.getMainSourceEditorId()) {
                            return;
                        }
                    }
                }

                let colBegin = 0;
                let colEnd = Number.POSITIVE_INFINITY;
                let lineBegin = obj.tag.line;
                let lineEnd = obj.tag.line;
                if (obj.tag.column) {
                    if (obj.tag.endcolumn) {
                        colBegin = obj.tag.column;
                        colEnd = obj.tag.endcolumn;
                        lineBegin = obj.tag.line;
                        lineEnd = obj.tag.endline;
                    } else {
                        const span = this.getTokenSpan(obj.tag.line ?? 0, obj.tag.column);
                        colBegin = obj.tag.column;
                        if (span.colEnd === obj.tag.column) colEnd = -1;
                        else if (span.colBegin === obj.tag.column) colEnd = span.colEnd;
                        else colEnd = obj.tag.column;
                    }
                }
                let link;
                if (obj.tag.link) {
                    link = {
                        value: obj.tag.link.text,
                        target: obj.tag.link.url as unknown as monaco.Uri,
                    };
                }

                const diag: monaco.editor.IMarkerData = {
                    severity: obj.tag.severity,
                    message: obj.tag.text,
                    source: obj.sourcePane,
                    startLineNumber: lineBegin ?? 0,
                    startColumn: colBegin,
                    endLineNumber: lineEnd ?? 0,
                    endColumn: colEnd,
                    code: link,
                };

                if (obj.tag.fixes && editorModel) {
                    fixes = fixes.concat(
                        obj.tag.fixes.map((fs, ind): monaco.languages.CodeAction => {
                            return {
                                title: fs.title,
                                diagnostics: [diag],
                                kind: 'quickfix',
                                edit: {
                                    edits: fs.edits.map((f): monaco.languages.IWorkspaceTextEdit => {
                                        return {
                                            resource: editorModel.uri,
                                            textEdit: {
                                                range: new monaco.Range(
                                                    f.line ?? 0,
                                                    f.column ?? 0,
                                                    f.endline ?? 0,
                                                    f.endcolumn ?? 0,
                                                ),
                                                text: f.text,
                                            },
                                            versionId: undefined,
                                        };
                                    }),
                                },
                                isPreferred: ind === 0,
                            };
                        }),
                    );
                }
                return diag;
            }),
        );

        return {
            fixes: fixes,
            widgets: widgets,
        };
    }

    setDecorationTags(widgets: editor.IMarkerData[], ownerId: string): void {
        const editorModel = this.editor.getModel();
        if (editorModel) monaco.editor.setModelMarkers(editorModel, ownerId, widgets);

        this.decorations.tags = widgets.map(
            tag => ({
                range: new monaco.Range(tag.startLineNumber, tag.startColumn, tag.startLineNumber + 1, 1),
                options: {
                    isWholeLine: false,
                    inlineClassName: 'error-code',
                },
            }),
            this,
        );

        this.updateDecorations();
    }

    setQuickFixes(fixes: monaco.languages.CodeAction[]): void {
        if (fixes.length) {
            const editorModel = this.editor.getModel();
            if (editorModel) {
                quickFixesHandler.registerQuickFixesForCompiler(this.id, editorModel, fixes);
                quickFixesHandler.registerProviderForLanguage(editorModel.getLanguageId());
            }
        } else {
            quickFixesHandler.unregister(this.id);
        }
    }

    override onCompileResult(compilerId: number, compiler: CompilerInfo, result: CompilationResult): void {
        if (!compiler || !this.ourCompilers[compilerId]) return;

        this.busyCompilers[compilerId] = false;

        const collectedOutput = this.collectOutputWidgets(
            this.getAllOutputAndErrors(result, compiler.name, compilerId),
        );

        this.setDecorationTags(collectedOutput.widgets, String(compilerId));
        this.setQuickFixes(collectedOutput.fixes);

        let asm: ResultLine[] = [];

        if (result.result?.asm) {
            asm = result.result.asm as ResultLine[];
        } else if (result.asm) {
            asm = result.asm as ResultLine[];
        }

        if (result.devices && Array.isArray(asm)) {
            asm = asm.concat(
                Object.values(result.devices).flatMap(device => {
                    return device.asm as ResultLine[];
                }),
            );
        }

        this.asmByCompiler[compilerId] = asm;

        if (result.inputFilename) {
            this.defaultFileByCompiler[compilerId] = result.inputFilename;
        } else {
            this.defaultFileByCompiler[compilerId] = 'example' + this.currentLanguage?.extensions[0];
        }

        this.numberUsedLines();
    }

    onExecuteResponse(executorId: number, compiler: CompilerInfo, result: CompilationResult): void {
        if (this.ourExecutors[executorId]) {
            let output = this.getAllOutputAndErrors(result, compiler.name, 'Execution ' + executorId);
            if (result.buildResult) {
                output = output.concat(
                    this.getAllOutputAndErrors(result.buildResult, compiler.name, 'Executor ' + executorId),
                );
            }
            this.setDecorationTags(this.collectOutputWidgets(output).widgets, 'Executor ' + executorId);

            this.numberUsedLines();
        }
    }

    onSelectLine(id: number, lineNum: number): void {
        if (Number(id) === this.id) {
            this.editor.setSelection(new monaco.Selection(lineNum - 1, 0, lineNum, 0));
        }
    }

    // Returns a half-segment [a, b) for the token on the line lineNum
    // that spans across the column.
    // a - colStart points to the first character of the token
    // b - colEnd points to the character immediately following the token
    // e.g.: "this->callableMethod ( x, y );"
    //              ^a   ^column  ^b
    getTokenSpan(lineNum: number, column: number): {colBegin: number; colEnd: number} {
        const model = this.editor.getModel();
        if (model && (lineNum < 1 || lineNum > model.getLineCount())) {
            // #3592 Be forgiving towards parsing errors
            return {colBegin: 0, colEnd: 0};
        }

        if (model && lineNum <= model.getLineCount()) {
            const line = model.getLineContent(lineNum);
            if (0 < column && column <= line.length) {
                const tokens = monaco.editor.tokenize(line, model.getLanguageId());
                if (tokens.length > 0) {
                    let lastOffset = 0;
                    let lastWasString = false;
                    for (let i = 0; i < tokens[0].length; ++i) {
                        // Treat all the contiguous string tokens as one,
                        // For example "hello \" world" is treated as one token
                        // instead of 3 "string.cpp", "string.escape.cpp", "string.cpp"
                        if (tokens[0][i].type.startsWith('string')) {
                            if (lastWasString) {
                                continue;
                            }
                            lastWasString = true;
                        } else {
                            lastWasString = false;
                        }
                        const currentOffset = tokens[0][i].offset;
                        if (column <= currentOffset) {
                            return {colBegin: lastOffset + 1, colEnd: currentOffset + 1};
                        }
                        lastOffset = currentOffset;
                    }
                    return {colBegin: lastOffset + 1, colEnd: line.length + 1};
                }
            }
        }
        return {colBegin: column, colEnd: column + 1};
    }

    pushRevealJump(): void {
        const state = this.editor.saveViewState();
        if (state) this.revealJumpStack.push(state);
        this.revealJumpStackHasElementsCtxKey.set(true);
    }

    popAndRevealJump(): void {
        if (this.revealJumpStack.length > 0) {
            const state = this.revealJumpStack.pop();
            if (state) this.editor.restoreViewState(state);
            this.revealJumpStackHasElementsCtxKey.set(this.revealJumpStack.length > 0);
        }
    }

    onEditorLinkLine(editorId: number, lineNum: number, columnBegin: number, columnEnd: number, reveal: boolean): void {
        if (Number(editorId) === this.id) {
            if (reveal && lineNum) {
                this.pushRevealJump();
                this.hub.activateTabForContainer(this.container);
                this.editor.revealLineInCenter(lineNum);
            }
            this.decorations.linkedCode = [];
            if (lineNum && lineNum !== -1) {
                this.decorations.linkedCode.push({
                    range: new monaco.Range(lineNum, 1, lineNum, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: 'linked-code-decoration-margin',
                        className: 'linked-code-decoration-line',
                    },
                });
            }

            if (lineNum > 0 && columnBegin !== -1) {
                const lastTokenSpan = this.getTokenSpan(lineNum, columnEnd);
                this.decorations.linkedCode.push({
                    range: new monaco.Range(lineNum, columnBegin, lineNum, lastTokenSpan.colEnd),
                    options: {
                        isWholeLine: false,
                        inlineClassName: 'linked-code-decoration-column',
                    },
                });
            }
            if (!this.settings.indefiniteLineHighlight) {
                if (this.fadeTimeoutId !== null) {
                    clearTimeout(this.fadeTimeoutId);
                }
                this.fadeTimeoutId = setTimeout(() => {
                    this.clearLinkedLine();
                    this.fadeTimeoutId = null;
                }, 5000);
            }
            this.updateDecorations();
        }
    }

    onEditorSetDecoration(id: number, lineNum: number, reveal: boolean, column?: number): void {
        if (Number(id) === this.id) {
            if (reveal && lineNum) {
                this.pushRevealJump();
                this.editor.revealLineInCenter(lineNum);
                this.editor.focus();
                this.editor.setPosition({column: column || 0, lineNumber: lineNum});
            }
            this.decorations.linkedCode = [];
            if (lineNum && lineNum !== -1) {
                this.decorations.linkedCode.push({
                    range: new monaco.Range(lineNum, 1, lineNum, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: 'linked-code-decoration-margin',
                        inlineClassName: 'linked-code-decoration-inline',
                    },
                });
            }
            this.updateDecorations();
        }
    }

    onEditorDisplayFlow(id: number, flow: MessageWithLocation[]): void {
        if (Number(id) === this.id) {
            if (this.decorations.flows?.length) {
                this.decorations.flows = [];
            } else {
                this.decorations.flows = flow.map((ri, ind) => {
                    return {
                        range: new monaco.Range(
                            ri.line ?? 0,
                            ri.column ?? 0,
                            (ri.endline || ri.line) ?? 0,
                            (ri.endcolumn || ri.column) ?? 0,
                        ),
                        options: {
                            before: {
                                content: ' ' + (ind + 1).toString() + ' ',
                                inlineClassName: 'flow-decoration',
                                cursorStops: monaco.editor.InjectedTextCursorStops.None,
                            },
                            inlineClassName: 'flow-highlight',
                            isWholeLine: false,
                            hoverMessage: {value: ri.text},
                        },
                    };
                });
            }
            this.updateDecorations();
        }
    }

    updateDecorations(): void {
        this.prevDecorations = this.editor.deltaDecorations(
            this.prevDecorations,
            _.compact(_.flatten(_.values(this.decorations))),
        );
    }

    onConformanceViewOpen(editorId: number): void {
        if (editorId === this.id) {
            this.conformanceViewerButton.attr('disabled', 1);
        }
    }

    onConformanceViewClose(editorId: number): void {
        if (editorId === this.id) {
            this.conformanceViewerButton.attr('disabled', null);
        }
    }

    showLoadSaver(): void {
        this.loadSaveButton.trigger('click');
    }

    initLoadSaver(): void {
        this.loadSaveButton.off('click').on('click', () => {
            if (this.currentLanguage) {
                loadSave.run(
                    (text, filename) => {
                        this.setSource(text);
                        this.setFilename(filename);
                        this.updateState();
                        this.maybeEmitChange(true);
                        this.requestCompilation();
                    },
                    this.getSource(),
                    this.currentLanguage,
                );
            }
        });
    }

    onLanguageChange(newLangId: LanguageKey, firstTime?: boolean): void {
        if (newLangId in languages) {
            if (firstTime || newLangId !== this.currentLanguage?.id) {
                const oldLangId = this.currentLanguage?.id;
                this.currentLanguage = languages[newLangId];
                if (!this.waitingForLanguage && !this.settings.keepSourcesOnLangChange && newLangId !== 'cmake') {
                    this.editorSourceByLang[oldLangId ?? ''] = this.getSource();
                    this.updateEditorCode();
                }
                this.initLoadSaver();
                const editorModel = this.editor.getModel();
                if (editorModel && this.currentLanguage)
                    monaco.editor.setModelLanguage(editorModel, this.currentLanguage.monaco);
                this.isCpp.set(this.currentLanguage?.id === 'c++');
                this.isClean.set(this.currentLanguage?.id === 'clean');
                this.updateLanguageTooltip();
                this.updateTitle();
                this.updateState();
                // Broadcast the change to other panels
                this.eventHub.emit('languageChange', this.id, newLangId);
                this.decorations = {};
                if (!firstTime) {
                    this.maybeEmitChange(true);
                    this.requestCompilation();
                }
            }
            this.waitingForLanguage = false;
        }
    }

    override getDefaultPaneName(): string {
        return 'Editor';
    }

    override getPaneName(): string {
        if (this.paneName) {
            return this.paneName;
        }
        if (this.filename) {
            return this.filename;
        }
        return this.currentLanguage?.name + ' source #' + this.id;
    }

    setFilename(name: string): void {
        this.filename = name;
        this.updateTitle();
        this.updateState();
    }

    getFilename(): string {
        return this.filename || '';
    }

    override updateTitle(): void {
        const name = this.getPaneName();
        const customName = this.paneName ? this.paneName : name;
        if (name.endsWith('CMakeLists.txt')) {
            this.changeLanguage('cmake');
        }
        this.container.setTitle(escapeHTML(customName));
    }

    // Called every time we change language, so we get the relevant code
    updateEditorCode(): void {
        this.setSource(
            this.editorSourceByLang[this.currentLanguage?.id ?? ''] ||
                languages[this.currentLanguage?.id ?? '']?.example,
        );
    }

    override close(): void {
        this.eventHub.unsubscribe();
        this.eventHub.emit('editorClose', this.id);
        this.editor.dispose();
        this.hub.removeEditor(this.id);
    }

    getSelectizeRenderHtml(language: Language, escapeHtml: typeof escape_html, width: number, height: number): string {
        return `
        <div class='d-flex' style='align-items: center'>
          <div class='me-1 d-flex' style='align-items: center; width: ${width}px; height: ${height}px'>
            ${
                language.logoFilename !== null
                    ? `
                <img src='${getStaticImage(language.logoFilename, 'logos')}'
                     alt='Logo for ${escapeHtml(language.name)}'
                     class='${language.logoFilenameDark ? 'theme-light-only' : ''}'
                     width='${width}px'
                     height='${height}px' />
                `
                    : ''
            }
            ${
                language.logoFilenameDark !== null
                    ? `
                <img src='${getStaticImage(language.logoFilenameDark, 'logos')}'
                     alt='Logo for ${escapeHtml(language.name)}'
                     class='theme-dark-only'
                     width='${width}px'
                     height='${height}px' />
               `
                    : ''
            }
          </div>
          <div title='${language.tooltip ?? ''}'>
            ${escapeHtml(language.name)}
          </div>
        </div>
        `;
    }

    renderSelectizeOption(data: Language, escapeHtml: typeof escape_html) {
        return this.getSelectizeRenderHtml(data, escapeHtml, 23, 23);
    }

    renderSelectizeItem(data: Language, escapeHtml: typeof escape_html) {
        return this.getSelectizeRenderHtml(data, escapeHtml, 20, 20);
    }

    onCompiler(compilerId: number, compiler: unknown, options: string, editorId: number, treeId: number): void {}

    updateLanguageTooltip() {
        // Dispose existing popover instance
        const existingPopover = BootstrapUtils.getPopoverInstance(this.languageInfoButton);
        if (existingPopover) existingPopover.dispose();

        if (this.currentLanguage?.tooltip) {
            BootstrapUtils.initPopover(this.languageInfoButton, {
                title: 'More info about this language',
                content: this.currentLanguage.tooltip,
                container: 'body',
                trigger: 'focus',
                placement: 'left',
            });
            this.languageInfoButton.show();
            this.languageInfoButton.prop('title', this.currentLanguage.tooltip);
        } else {
            this.languageInfoButton.hide();
        }
    }
}

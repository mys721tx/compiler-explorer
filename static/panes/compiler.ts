// Copyright (c) 2012, Compiler Explorer Authors
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

import {Container} from 'golden-layout';
import $ from 'jquery';
import {LRUCache} from 'lru-cache';
import * as monaco from 'monaco-editor';
import {editor} from 'monaco-editor';
import _ from 'underscore';
import {AssemblyInstructionInfo} from '../../types/assembly-docs.interfaces.js';
import {
    ActiveTool,
    BypassCache,
    CompilationRequest,
    CompilationRequestOptions,
    CompilationResult,
    FiledataPair,
    GccDumpFlags,
} from '../../types/compilation/compilation.interfaces.js';
import {OptPipelineBackendOptions} from '../../types/compilation/opt-pipeline-output.interfaces.js';
import {CompilerInfo} from '../../types/compiler.interfaces.js';
import {ResultLine} from '../../types/resultline/resultline.interfaces.js';
import {getAssemblyDocumentation} from '../api/api.js';
import * as BootstrapUtils from '../bootstrap-utils.js';
import * as codeLensHandler from '../codelens-handler.js';
import * as colour from '../colour.js';
import {CompilationStatus} from '../compiler-service.interfaces.js';
import {CompilerService} from '../compiler-service.js';
import {COMPILER_COMPONENT_NAME, ComponentConfig, NewToolSettings} from '../components.interfaces.js';
import * as Components from '../components.js';
import {createDragSource} from '../components.js';
import {Hub} from '../hub.js';
import * as LibUtils from '../lib-utils.js';
import * as monacoConfig from '../monaco-config.js';
import {LanguageLibs} from '../options.interfaces.js';
import {options} from '../options.js';
import {SiteSettings} from '../settings.js';
import * as utils from '../utils.js';
import {Alert} from '../widgets/alert.js';
import {CompilerPicker} from '../widgets/compiler-picker.js';
import {WidgetState} from '../widgets/libs-widget.interfaces.js';
import {LibsWidget} from '../widgets/libs-widget.js';
import * as TimingWidget from '../widgets/timing-info-widget.js';
import {Toggles} from '../widgets/toggles.js';
import {CompilerCurrentState, CompilerState} from './compiler.interfaces.js';
import {GccDumpFiltersState, GccDumpViewSelectedPass} from './gccdump-view.interfaces.js';
import {MonacoPaneState} from './pane.interfaces.js';
import {MonacoPane} from './pane.js';
import {PPOptions} from './pp-view.interfaces.js';

import IEditorMouseEvent = editor.IEditorMouseEvent;

import fileSaver from 'file-saver';
import {escapeHTML, splitArguments} from '../../shared/common-utils.js';
import {ClangirBackendOptions} from '../../types/compilation/clangir.interfaces.js';
import {LLVMIrBackendOptions} from '../../types/compilation/ir.interfaces.js';
import {CompilerOutputOptions} from '../../types/features/filters.interfaces.js';
import {InstructionSet} from '../../types/instructionsets.js';
import {LanguageKey} from '../../types/languages.interfaces.js';
import {Tool} from '../../types/tool.interfaces.js';
import {ArtifactHandler} from '../artifact-handler.js';
import {unwrap, unwrapString} from '../assert.js';
import {ICompilerShared} from '../compiler-shared.interfaces.js';
import {CompilerShared} from '../compiler-shared.js';
import {SourceAndFiles} from '../download-service.js';
import {SentryCapture} from '../sentry.js';
import {getStaticImage} from '../utils.js';
import {CompilerVersionInfo, setCompilerVersionPopoverForPane} from '../widgets/compiler-version-info.js';

type CachedOpcode = {
    found: boolean;
    data: AssemblyInstructionInfo | string;
};
const OpcodeCache = new LRUCache<string, CachedOpcode>({
    maxSize: 64 * 1024,
    sizeCalculation: n => JSON.stringify(n).length,
});

function patchOldFilters(filters: Partial<Record<string, boolean>> | undefined): Record<string, boolean> | undefined {
    if (filters === undefined) return undefined;
    // Filters are of the form {filter: true|false¸ ...}. In older versions, we used
    // to suppress the {filter:false} form. This means we can't distinguish between
    // "filter not on" and "filter not present". In the latter case we want to default
    // the filter. In the former case we want the filter off. Filters now don't suppress
    // but there are plenty of permalinks out there with no filters set at all. Here
    // we manually set any missing filters to 'false' to recover the old behaviour of
    // "if it's not here, it's off".
    ['binary', 'labels', 'directives', 'commentOnly', 'trim', 'intel', 'debugCalls'].forEach(oldFilter => {
        if (filters[oldFilter] === undefined) filters[oldFilter] = false;
    });
    return filters as Record<string, boolean>;
}

const languages = options.languages;

type LinkedCode = {
    range: monaco.Range;
    options: {
        isWholeLine: boolean;
        linesDecorationsClassName?: string;
        className?: string;
        inlineClassName?: string;
    };
};

type Decorations = Record<string, monaco.editor.IModelDeltaDecoration[]>;

type Assembly = {
    labels?: any[];
    source?: {
        line: number;
        column?: number;
        file?: string | null;
        mainsource?: any;
    };
    address?: number;
    opcodes?: string[];
    text?: string;
    fake?: boolean;
};

const COMPILING_PLACEHOLDER = '<Compiling...>';

// Disable max line count only for the constructor. Turns out, it needs to do quite a lot of things

export class Compiler extends MonacoPane<monaco.editor.IStandaloneCodeEditor, CompilerState> {
    private compilerService: CompilerService;
    private readonly id: number;
    private sourceTreeId: number | null;
    private sourceEditorId: number | null;
    private readonly infoByLang: Record<string, {compiler: string; options: string}>;
    private deferCompiles: boolean;
    private needsCompile: boolean;
    private deviceViewOpen: boolean;
    private options: string;
    private source: string;
    private assembly: Assembly[];
    private lastResult: CompilationResult | null;
    private lastTimeTaken: number;
    private previousScroll: number | null = null;
    private pendingRequestSentAt: number;
    private pendingCMakeRequestSentAt: number;
    private nextRequest: CompilationRequest | null;
    private nextCMakeRequest: CompilationRequest | null;
    private readonly decorations: Decorations;
    private prevDecorations: string[];
    private labelDefinitions: Record<any, number>;
    private alertSystem: Alert;
    private awaitingInitialResults: boolean;
    private linkedFadeTimeoutId: NodeJS.Timeout | null;
    private toolsMenu: JQuery<HTMLElement> | null;
    private revealJumpStack: (monaco.editor.ICodeEditorViewState | null)[];
    private compilerPicker: CompilerPicker;
    private compiler: CompilerInfo | null;
    private recentInstructionSet: InstructionSet | null;
    private currentLangId: string | null;
    private filters: Toggles;
    private optButton: JQuery<HTMLButtonElement>;
    private stackUsageButton: JQuery<HTMLButtonElement>;
    private flagsButton?: JQuery<HTMLButtonElement>;
    private ppButton: JQuery<HTMLButtonElement>;
    private astButton: JQuery<HTMLButtonElement>;
    private irButton: JQuery<HTMLButtonElement>;
    private clangirButton: JQuery<HTMLButtonElement>;
    private optPipelineButton: JQuery<HTMLButtonElement>;
    private deviceButton: JQuery<HTMLButtonElement>;
    private gnatDebugTreeButton: JQuery<HTMLButtonElement>;
    private gnatDebugButton: JQuery<HTMLButtonElement>;
    private rustMirButton: JQuery<HTMLButtonElement>;
    private rustMacroExpButton: JQuery<HTMLButtonElement>;
    private haskellCoreButton: JQuery<HTMLButtonElement>;
    private haskellStgButton: JQuery<HTMLButtonElement>;
    private haskellCmmButton: JQuery<HTMLButtonElement>;
    private gccDumpButton: JQuery<HTMLButtonElement>;
    private cfgButton: JQuery<HTMLButtonElement>;
    private executorButton: JQuery<HTMLButtonElement>;
    private libsButton: JQuery<HTMLButtonElement>;
    private compileInfoLabel: JQuery<HTMLElement>;
    private compileClearCache: JQuery<HTMLElement>;
    private outputBtn: JQuery<HTMLButtonElement>;
    private outputTextCount: JQuery<HTMLElement>;
    private outputErrorCount: JQuery<HTMLElement>;
    private optionsField: JQuery<HTMLElement>;
    private initialOptionsFieldPlacehoder: JQuery<HTMLElement>;
    private prependOptions: JQuery<HTMLElement>;
    private fullCompilerName: JQuery<HTMLElement>;
    private fullTimingInfo: JQuery<HTMLElement>;
    private compilerLicenseButton: JQuery<HTMLElement>;
    private filterBinaryButton: JQuery<HTMLButtonElement>;
    private filterBinaryTitle: JQuery<HTMLElement>;
    private filterBinaryObjectButton: JQuery<HTMLButtonElement>;
    private filterBinaryObjectTitle: JQuery<HTMLElement>;
    private filterExecuteButton: JQuery<HTMLButtonElement>;
    private filterExecuteTitle: JQuery<HTMLElement>;
    private filterLabelsButton: JQuery<HTMLButtonElement>;
    private filterLabelsTitle: JQuery<HTMLElement>;
    private filterDirectivesButton: JQuery<HTMLButtonElement>;
    private filterDirectivesTitle: JQuery<HTMLElement>;
    private filterLibraryCodeButton: JQuery<HTMLButtonElement>;
    private filterLibraryCodeTitle: JQuery<HTMLElement>;
    private filterCommentsButton: JQuery<HTMLButtonElement>;
    private filterCommentsTitle: JQuery<HTMLElement>;
    private filterTrimButton: JQuery<HTMLButtonElement>;
    private filterTrimTitle: JQuery<HTMLElement>;
    private filterDebugCallsButton: JQuery<HTMLButtonElement>;
    private filterDebugCallsTitle: JQuery<HTMLElement>;
    private filterIntelButton: JQuery<HTMLButtonElement>;
    private filterIntelTitle: JQuery<HTMLElement>;
    private filterDemangleButton: JQuery<HTMLButtonElement>;
    private filterDemangleTitle: JQuery<HTMLElement>;
    private filterVerboseDemanglingButton: JQuery<HTMLButtonElement>;
    private filterVerboseDemanglingTitle: JQuery<HTMLElement>;
    private noBinaryFiltersButtons: JQuery<HTMLButtonElement>;
    private shortCompilerName: JQuery<HTMLElement>;
    private bottomBar: JQuery<HTMLElement>;
    private statusLabel: JQuery<HTMLElement>;
    private statusIcon: JQuery<HTMLElement>;
    private rustHirButton: JQuery<HTMLButtonElement>;
    private libsWidget: LibsWidget | null;
    private isLabelCtxKey: monaco.editor.IContextKey<boolean>;
    private revealJumpStackHasElementsCtxKey: monaco.editor.IContextKey<boolean>;
    private isAsmKeywordCtxKey: monaco.editor.IContextKey<boolean>;
    private lineHasLinkedSourceCtxKey: monaco.editor.IContextKey<boolean>;

    private flagsViewOpen: boolean;
    private stackUsageViewOpen: boolean;
    private optViewOpen: boolean;
    private cfgViewOpenCount: number;
    private irCfgViewOpenCount: number;
    private wantOptInfo?: boolean;
    private ppViewOpen: boolean;
    private astViewOpen: boolean;
    private irViewOpen: boolean;
    private clangirViewOpen: boolean;
    private optPipelineViewOpenCount: number;
    private gccDumpViewOpen: boolean;
    private gccDumpPassSelected?: GccDumpViewSelectedPass;
    private treeDumpEnabled?: boolean;
    private rtlDumpEnabled?: boolean;
    private ipaDumpEnabled?: boolean;
    private dumpFlags?: GccDumpFlags;
    private gnatDebugTreeViewOpen: boolean;
    private gnatDebugViewOpen: boolean;
    private rustMirViewOpen: boolean;
    private rustMacroExpViewOpen: boolean;
    private rustHirViewOpen: boolean;
    private haskellCoreViewOpen: boolean;
    private haskellStgViewOpen: boolean;
    private haskellCmmViewOpen: boolean;
    private ppOptions: PPOptions;
    private llvmIrOptions: LLVMIrBackendOptions;
    private clangirOptions: ClangirBackendOptions;
    private optPipelineOptions: OptPipelineBackendOptions;
    private isOutputOpened: boolean;
    private mouseMoveThrottledFunction?: ((e: monaco.editor.IEditorMouseEvent) => void) & _.Cancelable;
    private cursorSelectionThrottledFunction?: ((e: monaco.editor.ICursorSelectionChangedEvent) => void) & _.Cancelable;
    private mouseUpThrottledFunction?: ((e: monaco.editor.IEditorMouseEvent) => void) & _.Cancelable;
    private compilerShared: ICompilerShared;
    private artifactHandler: ArtifactHandler;

    constructor(hub: Hub, container: Container, state: MonacoPaneState & CompilerState) {
        super(hub, container, state);

        this.id = state.id || hub.nextCompilerId();

        this.infoByLang = {};
        this.deferCompiles = true;
        this.needsCompile = false;
        this.initLangAndCompiler(state);

        this.source = '';
        this.assembly = [];
        this.lastResult = null;

        this.lastTimeTaken = 0;
        this.pendingRequestSentAt = 0;
        this.pendingCMakeRequestSentAt = 0;
        this.nextRequest = null;
        this.nextCMakeRequest = null;
        this.optViewOpen = false;
        this.cfgViewOpenCount = 0;
        this.irCfgViewOpenCount = 0;
        this.optPipelineViewOpenCount = 0;

        this.decorations = {
            labelUsages: [],
        };
        this.prevDecorations = [];
        this.labelDefinitions = {};
        this.alertSystem = new Alert();
        this.alertSystem.prefixMessage = 'Compiler #' + this.id;

        this.artifactHandler = new ArtifactHandler(this.alertSystem);

        this.awaitingInitialResults = false;

        this.linkedFadeTimeoutId = null;
        this.toolsMenu = null;

        this.revealJumpStack = [];

        // MonacoPane's registerButtons is not called late enough, we still need to init some buttons with new data
        this.initPanerButtons();

        this.compilerPicker = new CompilerPicker(
            this.domRoot,
            this.hub,
            this.currentLangId ?? '',
            this.compiler?.id ?? '',
            this.onCompilerChange.bind(this),
        );
        this.initLibraries(state);
        this.compilerShared = new CompilerShared(this.domRoot, this.onCompilerOverridesChange.bind(this));
        this.compilerShared.updateState(state);
        // MonacoPane's registerCallbacks is not called late enough either
        this.initCallbacks();
        // Handle initial settings
        this.onSettingsChange(this.settings);
        this.sendCompiler();
        this.updateCompilerInfo();
        this.updateButtons();
        this.updateState();

        if (this.sourceTreeId) {
            this.compile();
        }

        if (!this.hub.deferred) {
            this.undefer();
        }
    }

    override initializeStateDependentProperties(state: MonacoPaneState & CompilerState) {
        this.compilerService = this.hub.compilerService;
        this.sourceTreeId = state.tree ? state.tree : null;
        if (this.sourceTreeId) {
            this.sourceEditorId = null;
        } else {
            this.sourceEditorId = state.source || 1;
        }
        this.options = state.options || (options.compileOptions[this.currentLangId ?? ''] ?? '');

        this.deviceViewOpen = !!state.deviceViewOpen;
        this.flagsViewOpen = state.flagsViewOpen || false;
        this.wantOptInfo = state.wantOptInfo;
        this.selection = state.selection;
    }

    override getInitialHTML() {
        return $('#compiler').html();
    }

    override createEditor(editorRoot: HTMLElement) {
        this.editor = monaco.editor.create(
            editorRoot,
            monacoConfig.extendConfig(
                {
                    readOnly: true,
                    language: 'asm',
                    glyphMargin: !options.embedded,
                    guides: {
                        bracketPairs: false,
                        bracketPairsHorizontal: false,
                        highlightActiveBracketPair: false,
                        highlightActiveIndentation: false,
                        indentation: false,
                    },
                    vimInUse: false,
                },
                this.settings,
            ),
        );
    }

    override getPrintName() {
        return 'Compiler Output';
    }

    getEditorIdBySourcefile(sourcefile: Assembly['source']): number | null {
        if (this.sourceTreeId) {
            const tree = this.hub.getTreeById(this.sourceTreeId);
            if (tree) {
                return tree.multifileService.getEditorIdByFilename(sourcefile?.file ?? '');
            }
        } else {
            if (sourcefile != null && (sourcefile.file === null || sourcefile.mainsource)) {
                return this.sourceEditorId;
            }
        }

        return null;
    }

    initLangAndCompiler(state: Pick<MonacoPaneState & CompilerState, 'lang' | 'compiler'>): void {
        const langId = state.lang;
        const compilerId = state.compiler;
        const result = this.compilerService.processFromLangAndCompiler(langId ?? null, compilerId);
        this.compiler = result?.compiler ?? null;
        this.currentLangId = result?.langId ?? null;
        this.updateLibraries();
    }

    override close(): void {
        codeLensHandler.unregister(this.id);
        this.eventHub.unsubscribe();
        this.eventHub.emit('compilerClose', this.id, this.sourceTreeId ?? 0);
        this.editor.dispose();
        this.compilerPicker.destroy();
    }

    onCompiler(compilerId: number, compiler: unknown, options: string, editorId: number, treeId: number): void {}

    onCompileResult(compilerId: number, compiler: unknown, result: unknown): void {}

    initPanerButtons(): void {
        const outputConfig = Components.getOutput(this.id, this.sourceEditorId ?? 0, this.sourceTreeId ?? 0);

        this.container.layoutManager.createDragSource(this.outputBtn, outputConfig);
        this.outputBtn.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(outputConfig);
        });

        const DEFAULT_EDITOR_ID = 1;

        const cloneComponent = (): ComponentConfig<typeof COMPILER_COMPONENT_NAME> => {
            const currentState = this.getCurrentState();

            // Extract only the fields we need, with proper defaults
            const {source = DEFAULT_EDITOR_ID, filters, options = '', compiler, libs, lang} = currentState;

            return {
                type: 'component',
                componentName: COMPILER_COMPONENT_NAME,
                componentState: {source, filters, options, compiler, libs, lang},
            };
        };
        const createOptView = () => {
            return Components.getOptViewWith(
                this.id,
                this.source,
                this.lastResult?.optOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };
        const createStackUsageView = () => {
            return Components.getStackUsageViewWith(
                this.id,
                this.source,
                this.lastResult?.optOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createFlagsView = () => {
            return Components.getFlagsViewWith(this.id, this.getCompilerName(), this.optionsField.val());
        };

        if (this.flagsViewOpen) {
            createFlagsView();
        }

        const createPpView = () => {
            return Components.getPpViewWith(
                this.id,
                this.source,
                this.lastResult?.ppOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createAstView = () => {
            return Components.getAstViewWith(
                this.id,
                this.source,
                this.lastResult?.astOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createIrView = () => {
            return Components.getIrViewWith(
                this.id,
                this.source,
                this.lastResult?.irOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createClangirView = () => {
            return Components.getClangirViewWith(
                this.id,
                this.source,
                this.lastResult?.irOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createOptPipelineView = () => {
            const currentState = this.getCurrentState();
            const langId = currentState.lang;
            const compilerId = currentState.compiler;
            return Components.getOptPipelineViewWith(
                this.id,
                langId ?? '',
                compilerId,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createDeviceView = () => {
            return Components.getDeviceViewWith(
                this.id,
                this.source,
                this.lastResult?.devices,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createRustMirView = () => {
            return Components.getRustMirViewWith(
                this.id,
                this.source,
                this.lastResult?.rustMirOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createRustMacroExpView = () => {
            return Components.getRustMacroExpViewWith(
                this.id,
                this.source,
                this.lastResult?.rustMacroExpOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createRustHirView = () => {
            return Components.getRustHirViewWith(
                this.id,
                this.source,
                this.lastResult?.rustHirOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createHaskellCoreView = () => {
            return Components.getHaskellCoreViewWith(
                this.id,
                this.source,
                this.lastResult?.haskellCoreOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createHaskellStgView = () => {
            return Components.getHaskellStgViewWith(
                this.id,
                this.source,
                this.lastResult?.haskellStgOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createHaskellCmmView = () => {
            return Components.getHaskellCmmViewWith(
                this.id,
                this.source,
                this.lastResult?.haskellCmmOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createGccDumpView = () => {
            return Components.getGccDumpViewWith(
                this.id,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
                this.lastResult?.gccDumpOutput,
            );
        };

        const createGnatDebugTreeView = () => {
            return Components.getGnatDebugTreeViewWith(
                this.id,
                this.source,
                this.lastResult?.gnatDebugTreeOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createGnatDebugView = () => {
            return Components.getGnatDebugViewWith(
                this.id,
                this.source,
                this.lastResult?.gnatDebugOutput,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                this.sourceTreeId ?? 0,
            );
        };

        const createCfgView = () => {
            return Components.getCfgViewWith(this.id, this.sourceEditorId ?? 0, this.sourceTreeId ?? 0);
        };

        const createExecutor = () => {
            const currentState = this.getCurrentState();
            const editorId = currentState.source;
            const treeId = currentState.tree;
            const langId = currentState.lang;
            const compilerId = currentState.compiler;
            const libs =
                this.libsWidget?.getLibsInUse().map(item => ({
                    name: item.libId,
                    ver: item.versionId,
                })) ?? [];

            return Components.getExecutorWith(
                editorId ?? 0,
                langId ?? '',
                compilerId,
                libs,
                currentState.options,
                treeId ?? 0,
                currentState.overrides,
                currentState.runtimeTools,
            );
        };

        const newPaneDropdown = this.domRoot.find('.new-pane-dropdown');
        const hidePaneAdder = () => {
            BootstrapUtils.hideDropdown(newPaneDropdown);
        };

        // Note that the .d.ts file lies in more than 1 way!
        // createDragSource returns the newly created DragSource
        // the second parameter can be a function that returns the config!
        createDragSource(this.container.layoutManager, this.domRoot.find('.btn.add-compiler'), () =>
            cloneComponent(),
        ).on('dragStart', hidePaneAdder);

        this.domRoot.find('.btn.add-compiler').on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(cloneComponent());
        });

        createDragSource(this.container.layoutManager, this.optButton, () => createOptView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.optButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createOptView());
        });

        createDragSource(this.container.layoutManager, this.stackUsageButton, () => createStackUsageView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.stackUsageButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createStackUsageView());
        });

        if (this.flagsButton) {
            const popularArgumentsMenu = this.domRoot.find('div.populararguments div.dropdown-menu');
            createDragSource(this.container.layoutManager, this.flagsButton, () => createFlagsView()).on(
                'dragStart',
                () => BootstrapUtils.hideDropdown(popularArgumentsMenu),
            );

            this.flagsButton.on('click', () => {
                const insertPoint =
                    this.hub.findParentRowOrColumn(this.container.parent) ||
                    this.container.layoutManager.root.contentItems[0];
                insertPoint.addChild(createFlagsView());
            });

            popularArgumentsMenu.append(this.flagsButton);
        }

        createDragSource(this.container.layoutManager, this.ppButton, () => createPpView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.ppButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createPpView());
        });

        createDragSource(this.container.layoutManager, this.astButton, () => createAstView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.astButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createAstView());
        });

        createDragSource(this.container.layoutManager, this.irButton, () => createIrView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.irButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createIrView());
        });

        createDragSource(this.container.layoutManager, this.clangirButton, () => createClangirView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.clangirButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createClangirView());
        });

        createDragSource(this.container.layoutManager, this.optPipelineButton, () => createOptPipelineView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.optPipelineButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createOptPipelineView());
        });

        createDragSource(this.container.layoutManager, this.deviceButton, () => createDeviceView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.deviceButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createDeviceView());
        });

        createDragSource(this.container.layoutManager, this.rustMirButton, () => createRustMirView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.rustMirButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createRustMirView());
        });

        createDragSource(this.container.layoutManager, this.haskellCoreButton, () => createHaskellCoreView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.haskellCoreButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createHaskellCoreView());
        });

        createDragSource(this.container.layoutManager, this.haskellStgButton, () => createHaskellStgView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.haskellStgButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createHaskellStgView());
        });

        createDragSource(this.container.layoutManager, this.haskellCmmButton, () => createHaskellCmmView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.haskellCmmButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createHaskellCmmView());
        });

        createDragSource(this.container.layoutManager, this.rustMacroExpButton, () => createRustMacroExpView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.rustMacroExpButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createRustMacroExpView());
        });

        createDragSource(this.container.layoutManager, this.rustHirButton, () => createRustHirView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.rustHirButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createRustHirView());
        });

        createDragSource(this.container.layoutManager, this.gccDumpButton, () => createGccDumpView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.gccDumpButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createGccDumpView());
        });

        createDragSource(this.container.layoutManager, this.gnatDebugTreeButton, () => createGnatDebugTreeView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.gnatDebugTreeButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createGnatDebugTreeView());
        });

        createDragSource(this.container.layoutManager, this.gnatDebugButton, () => createGnatDebugView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.gnatDebugButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createGnatDebugView());
        });

        createDragSource(this.container.layoutManager, this.cfgButton, () => createCfgView()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.cfgButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createCfgView());
        });

        createDragSource(this.container.layoutManager, this.executorButton, () => createExecutor()).on(
            'dragStart',
            hidePaneAdder,
        );

        this.executorButton.on('click', () => {
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createExecutor());
        });

        this.initToolButtons();
    }

    undefer(): void {
        this.deferCompiles = false;
        if (this.needsCompile) {
            this.compile();
        }
    }

    // Returns a label name if it can be found in the given position, otherwise
    // returns null.
    getLabelAtPosition(position: monaco.Position): any | null {
        const asmLine = this.assembly[position.lineNumber - 1];
        // Outdated position.lineNumber can happen (Between compilations?) - Check for those and skip

        if (asmLine) {
            const column = position.column;
            const labels = asmLine.labels || [];

            for (let i = 0; i < labels.length; ++i) {
                if (column >= labels[i].range.startCol && column < labels[i].range.endCol) {
                    return labels[i];
                }
            }
        }
        return null;
    }

    // Jumps to a label definition related to a label which was found in the
    // given position and highlights the given range. If no label can be found in
    // the given position it do nothing.
    jumpToLabel(position: monaco.Position): void {
        const label = this.getLabelAtPosition(position);

        if (!label) {
            return;
        }

        const target = label.target || label.name;
        if (!this.labelDefinitions.hasOwnProperty(target)) {
            return;
        }

        const labelDefLineNum = this.labelDefinitions[target];

        // Highlight the new range.
        const endLineContent = this.editor.getModel()?.getLineContent(labelDefLineNum);

        this.pushRevealJump();

        this.editor.setSelection(
            new monaco.Selection(labelDefLineNum, 0, labelDefLineNum, (endLineContent?.length ?? 0) + 1),
        );

        // Jump to the given line.
        this.editor.revealLineInCenter(labelDefLineNum);
    }

    pushRevealJump(): void {
        this.revealJumpStack.push(this.editor.saveViewState());
        this.revealJumpStackHasElementsCtxKey.set(true);
    }

    popAndRevealJump(): void {
        if (this.revealJumpStack.length > 0) {
            this.editor.restoreViewState(this.revealJumpStack.pop() ?? null);
            this.revealJumpStackHasElementsCtxKey.set(this.revealJumpStack.length > 0);
        }
    }

    override registerEditorActions(): void {
        this.isLabelCtxKey = this.editor.createContextKey('isLabel', true);
        this.revealJumpStackHasElementsCtxKey = this.editor.createContextKey('hasRevealJumpStackElements', false);
        this.isAsmKeywordCtxKey = this.editor.createContextKey('isAsmKeyword', true);
        this.lineHasLinkedSourceCtxKey = this.editor.createContextKey('lineHasLinkedSource', false);

        this.editor.addAction({
            id: 'jumptolabel',
            label: 'Jump to label',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
            precondition: 'isLabel',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1.5,
            run: ed => {
                const position = ed.getPosition();
                if (position != null) {
                    this.jumpToLabel(position);
                }
            },
        });

        // This returns a vscode's ContextMenuController, but that type is not exposed in Monaco
        const contextMenuContrib = this.editor.getContribution<any>('editor.contrib.contextmenu');

        // This is hacked this way to be able to update the precondition keys before the context menu is shown.
        // Right now Monaco does not expose a proper way to update those preconditions before the menu is shown,
        // because the editor.onContextMenu callback fires after it's been shown, so it's of little use here
        // The original source is src/vs/editor/contrib/contextmenu/browser/contextmenu.ts in vscode
        const originalOnContextMenu: ((e: IEditorMouseEvent) => void) | undefined = contextMenuContrib._onContextMenu;
        if (originalOnContextMenu) {
            contextMenuContrib._onContextMenu = (e: IEditorMouseEvent) => {
                if (e.target.position) {
                    // Hiding the 'Jump to label' context menu option if no label can be found
                    // in the clicked position.
                    const label = this.getLabelAtPosition(e.target.position);
                    this.isLabelCtxKey.set(label !== null);

                    if (!this.compiler?.supportsAsmDocs) {
                        // No need to show the "Show asm documentation" if it's just going to fail.
                        // This is useful for things like xtensa which define an instructionSet but have no docs associated
                        this.isAsmKeywordCtxKey.set(false);
                    } else {
                        const currentWord = this.editor.getModel()?.getWordAtPosition(e.target.position);
                        if (currentWord?.word) {
                            this.isAsmKeywordCtxKey.set(
                                this.isWordAsmKeyword(e.target.position.lineNumber, currentWord),
                            );
                        }
                    }

                    const prevLineNumber = e.target.position.lineNumber - 1;
                    if (prevLineNumber >= 0 && prevLineNumber < this.assembly.length) {
                        const lineSource = this.assembly[prevLineNumber].source;

                        this.lineHasLinkedSourceCtxKey.set(lineSource != null && lineSource.line > 0);
                    }

                    // And call the original method now that we've updated the context keys
                    originalOnContextMenu.apply(contextMenuContrib, [e]);
                }
            };
        } else {
            // In case this ever stops working, we'll be notified
            SentryCapture(new Error('Context menu hack did not return valid original method'));
        }

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
            id: 'viewsource',
            label: 'Scroll to source',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
            keybindingContext: undefined,
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 1.5,
            precondition: 'lineHasLinkedSource',
            run: ed => {
                const position = ed.getPosition();
                if (position != null) {
                    const desiredLine = position.lineNumber - 1;
                    const source = this.assembly[desiredLine].source;
                    // The precondition ensures that this is always true, but lets not blindly belive it
                    if (source && source.line > 0) {
                        const editorId = this.getEditorIdBySourcefile(source);
                        if (editorId) {
                            // a null file means it was the user's source
                            this.eventHub.emit('editorLinkLine', editorId, source.line, -1, -1, true);
                        }
                    }
                }
            },
        });

        this.editor.addAction({
            id: 'viewasmdoc',
            label: 'View assembly documentation',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F8],
            keybindingContext: undefined,
            precondition: 'isAsmKeyword',
            contextMenuGroupId: 'help',
            contextMenuOrder: 1.5,
            run: this.onAsmToolTip.bind(this),
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
            id: 'dumpAsm',
            label: 'Developer: Dump asm',
            run: () => {
                console.log(this.assembly);
            },
        });
    }

    // Gets the filters that will actually be used (accounting for issues with binary
    // mode etc).
    getEffectiveFilters(): Partial<CompilerOutputOptions> {
        if (!this.compiler) return {};
        const filters = this.filters.get();
        if (filters.binaryObject && !this.compiler.supportsBinaryObject) {
            delete filters.binaryObject;
        }

        if (filters.binary && !this.compiler.supportsBinary) {
            delete filters.binary;
        }
        if (filters.execute && !this.compiler.supportsExecute && !this.compiler.supportsBinary) {
            delete filters.execute;
        }
        if (filters.libraryCode && !this.compiler.supportsLibraryCodeFilter) {
            delete filters.libraryCode;
        }
        if (filters.verboseDemangling && !this.compiler.supportsVerboseDemangling) {
            delete filters.verboseDemangling;
        }
        this.compiler.disabledFilters.forEach(filter => {
            if (filters[filter]) {
                delete filters[filter];
            }
        });
        return filters;
    }

    findTools(content: any, tools: ActiveTool[]): ActiveTool[] {
        if (content.componentName === 'tool') {
            if (content.componentState.id === this.id) {
                tools.push({
                    id: content.componentState.toolId,
                    args: splitArguments(content.componentState.args),
                    stdin: content.componentState.stdin,
                });
            }
        } else if (content.content) {
            content.content.forEach((subcontent: any) => {
                tools = this.findTools(subcontent, tools);
            });
        }

        return tools;
    }

    getActiveTools(newToolSettings?: NewToolSettings): ActiveTool[] {
        if (!this.compiler) return [];

        const tools: ActiveTool[] = [];
        if (newToolSettings) {
            tools.push({
                id: newToolSettings.toolId,
                args: splitArguments(newToolSettings.args),
                stdin: newToolSettings.stdin ?? '',
            });
        }

        if (this.container.layoutManager.isInitialised) {
            const config = this.container.layoutManager.toConfig();
            return this.findTools(config, tools);
        }
        return tools;
    }

    isToolActive(activetools: ActiveTool[], toolId: string): ActiveTool | undefined {
        return activetools.find(tool => tool.id === toolId);
    }

    compile(bypassCache?: boolean, newTools?: NewToolSettings): void {
        if (this.deferCompiles) {
            this.needsCompile = true;
            return;
        }

        this.needsCompile = false;
        this.compileInfoLabel.text(' - Compiling...');
        const options: CompilationRequestOptions = {
            userArguments: this.options,
            compilerOptions: {
                producePp: this.ppViewOpen ? this.ppOptions : null,
                produceAst: this.astViewOpen,
                produceGccDump: {
                    opened: this.gccDumpViewOpen,
                    pass: this.gccDumpPassSelected,
                    treeDump: this.treeDumpEnabled,
                    rtlDump: this.rtlDumpEnabled,
                    ipaDump: this.ipaDumpEnabled,
                    dumpFlags: this.dumpFlags,
                },
                produceOptInfo: this.wantOptInfo ?? false,
                produceStackUsageInfo: this.stackUsageViewOpen,
                produceCfg:
                    this.cfgViewOpenCount > 0
                        ? {
                              asm: this.cfgViewOpenCount - this.irCfgViewOpenCount > 0,
                              ir: this.irCfgViewOpenCount > 0,
                          }
                        : false,
                produceGnatDebugTree: this.gnatDebugTreeViewOpen,
                produceGnatDebug: this.gnatDebugViewOpen,
                produceIr: this.irViewOpen ? this.llvmIrOptions : null,
                produceClangir: this.clangirViewOpen ? this.clangirOptions : null,
                produceOptPipeline: this.optPipelineViewOpenCount > 0 ? this.optPipelineOptions : null,
                produceDevice: this.deviceViewOpen,
                produceRustMir: this.rustMirViewOpen,
                produceRustMacroExp: this.rustMacroExpViewOpen,
                produceRustHir: this.rustHirViewOpen,
                produceHaskellCore: this.haskellCoreViewOpen,
                produceHaskellStg: this.haskellStgViewOpen,
                produceHaskellCmm: this.haskellCmmViewOpen,
                overrides: this.getCurrentState().overrides,
            },
            filters: this.getEffectiveFilters(),
            tools: this.getActiveTools(newTools),
            libraries:
                this.libsWidget?.getLibsInUse().map(item => ({
                    id: item.libId,
                    version: item.versionId,
                })) ?? [],
            executeParameters: {
                args: [],
                stdin: '',
                runtimeTools: this.getCurrentState().runtimeTools,
            },
        };

        if (this.sourceTreeId) {
            this.compileFromTree(options, bypassCache ?? false);
        } else {
            this.compileFromEditorSource(options, bypassCache ?? false);
        }
    }

    compileFromTree(options: CompilationRequestOptions, bypassCache: boolean): void {
        const tree = this.hub.getTreeById(this.sourceTreeId ?? 0);
        if (!tree) {
            this.sourceTreeId = null;
            this.compileFromEditorSource(options, bypassCache);
            return;
        }

        const request: CompilationRequest = {
            source: tree.multifileService.getMainSource(),
            compiler: this.compiler ? this.compiler.id : '',
            options: options,
            lang: this.currentLangId,
            files: tree.multifileService.getFiles(),
            bypassCache: BypassCache.None,
        };

        const fetches: Promise<void>[] = [];
        fetches.push(
            this.compilerService.expandToFiles(request.source).then((sourceAndFiles: SourceAndFiles) => {
                request.source = sourceAndFiles.source;
                request.files.push(...sourceAndFiles.files);
            }),
        );

        const moreFiles: FiledataPair[] = [];
        for (let i = 0; i < request.files.length; i++) {
            const file = request.files[i];
            fetches.push(
                this.compilerService.expandToFiles(file.contents).then((sourceAndFiles: SourceAndFiles) => {
                    file.contents = sourceAndFiles.source;
                    moreFiles.push(...sourceAndFiles.files);
                }),
            );
        }

        Promise.all(fetches)
            .then(() => {
                const treeState = tree.currentState();
                const cmakeProject = tree.multifileService.isACMakeProject();
                request.files.push(...moreFiles);

                if (bypassCache) request.bypassCache = BypassCache.Compilation;
                if (!this.compiler) {
                    this.onCompileResponse(request, this.errorResult('<Please select a compiler>'), false);
                } else if (cmakeProject && request.source === '') {
                    this.onCompileResponse(request, this.errorResult('<Please supply a CMakeLists.txt>'), false);
                } else {
                    if (cmakeProject) {
                        request.options.compilerOptions.cmakeArgs = treeState.cmakeArgs;
                        request.options.compilerOptions.customOutputFilename = treeState.customOutputFilename;
                        this.sendCMakeCompile(request);
                    } else {
                        this.sendCompile(request);
                    }
                }
            })
            .catch(error => {
                this.onCompileResponse(
                    request,
                    this.errorResult('Failed to expand includes in files: ' + error.message),
                    false,
                );
            });
    }

    compileFromEditorSource(options: CompilationRequestOptions, bypassCache: boolean) {
        this.compilerService
            .expandToFiles(this.source)
            .then((sourceAndFiles: SourceAndFiles) => {
                const request: CompilationRequest = {
                    source: sourceAndFiles.source || '',
                    compiler: this.compiler ? this.compiler.id : '',
                    options: options,
                    lang: this.currentLangId,
                    files: sourceAndFiles.files,
                    bypassCache: BypassCache.None,
                };
                if (bypassCache) request.bypassCache = BypassCache.Compilation;
                if (!this.compiler) {
                    this.onCompileResponse(request, this.errorResult('<Please select a compiler>'), false);
                } else {
                    this.sendCompile(request);
                }
            })
            .catch(error => {
                this.onCompileResponse(
                    {
                        source: this.source,
                        compiler: this.compiler?.id || '',
                        options: options,
                        lang: this.currentLangId,
                        files: [],
                    },
                    this.errorResult('Failed to expand includes: ' + error.message),
                    false,
                );
            });
    }

    makeCompilingPlaceholderTimeout() {
        return setTimeout(() => {
            if (!_.isEqual(this.assembly, COMPILING_PLACEHOLDER)) {
                const scroll = this.editor.getScrollTop();
                this.setAssembly({asm: this.fakeAsm(COMPILING_PLACEHOLDER)}, 0);
                this.previousScroll = scroll;
            }
        }, 500);
    }

    sendCMakeCompile(request: CompilationRequest) {
        if (this.pendingCMakeRequestSentAt) {
            // If we have a request pending, then just store this request to do once the
            // previous request completes.
            this.nextCMakeRequest = request;
            return;
        }
        if (this.compiler) this.eventHub.emit('compiling', this.id, this.compiler);
        // Display the spinner
        this.handleCompilationStatus({code: 4, compilerOut: 0});
        this.pendingCMakeRequestSentAt = Date.now();
        // After a short delay, give the user some indication that we're working on their
        // compilation.
        const progress = this.makeCompilingPlaceholderTimeout();
        this.compilerService
            .submitCMake(request)
            .then((x: any) => {
                clearTimeout(progress);
                this.onCMakeResponse(request, x?.result, x?.localCacheHit ?? false);
            })
            .catch(x => {
                clearTimeout(progress);
                let message = 'Unknown error';
                if (typeof x === 'string' || x instanceof String) {
                    message = x.toString();
                } else if (x) {
                    message = x.error || x.code || message;
                }
                this.onCMakeResponse(request, this.errorResult('<Compilation failed: ' + message + '>'), false);
            });
    }

    sendCompile(request: CompilationRequest) {
        const onCompilerResponse = this.onCompileResponse.bind(this);

        if (this.pendingRequestSentAt) {
            // If we have a request pending, then just store this request to do once the
            // previous request completes.
            this.nextRequest = request;
            return;
        }
        if (this.compiler) this.eventHub.emit('compiling', this.id, this.compiler);
        // Display the spinner
        this.handleCompilationStatus({code: 4, compilerOut: 0});
        this.pendingRequestSentAt = Date.now();
        // After a short delay, give the user some indication that we're working on their
        // compilation.
        const progress = this.makeCompilingPlaceholderTimeout();
        this.compilerService
            .submit(request)
            .then((x: any) => {
                clearTimeout(progress);
                onCompilerResponse(request, x.result, x.localCacheHit);
            })
            .catch(e => {
                clearTimeout(progress);
                let message = 'Unknown error';
                if (typeof e === 'string' || e instanceof String) {
                    message = e.toString();
                } else if (e) {
                    message = e.error || e.code || e.message;
                    if (e.stack) {
                        console.log(e);
                    }
                }
                onCompilerResponse(request, this.errorResult('<Compilation failed: ' + message + '>'), false);
            });
    }

    setNormalMargin(): void {
        this.editor.updateOptions({
            lineNumbers: 'on',
            lineNumbersMinChars: 1,
        });
    }

    setBinaryMargin(): void {
        this.editor.updateOptions({
            lineNumbersMinChars: 6,
            lineNumbers: this.getBinaryForLine.bind(this),
        });
    }

    getBinaryForLine(line: number): string {
        const obj = this.assembly[line - 1];

        if (obj) {
            return obj.address != null ? obj.address.toString(16) : '';
        }
        return '???';
    }

    setAssembly(result: Partial<CompilationResult>, filteredCount = 0) {
        this.recentInstructionSet = result.instructionSet || null;

        const asm = result.asm || this.fakeAsm('<No output>');
        this.assembly = asm as ResultLine[];
        if (!this.editor.getModel()) return;
        const editorModel = this.editor.getModel();
        if (editorModel) {
            if (result.languageId) {
                monaco.editor.setModelLanguage(editorModel, result.languageId);
            } else {
                let monacoDisassembly = 'asm';
                if (this.currentLangId && this.currentLangId in languages) {
                    // TS compiler trips if you try to fold this condition in one if
                    const disasam = languages[this.currentLangId].monacoDisassembly;
                    if (disasam !== null) {
                        monacoDisassembly = disasam;
                    }
                }
                monaco.editor.setModelLanguage(editorModel, monacoDisassembly);
            }
        }
        let msg = '<No assembly generated>';
        if (asm.length) {
            msg = _.pluck(asm, 'text').join('\n');
        } else if (filteredCount > 0) {
            msg =
                '<No assembly to display (~' +
                filteredCount +
                (filteredCount === 1 ? ' line' : ' lines') +
                ' filtered)>';
        }

        if (asm.length === 1 && result.code !== 0 && (result.stderr || result.stdout)) {
            msg += '\n\n# For more information see the output window';
            if (!this.isOutputOpened) {
                msg += '\n# To open the output window, click or drag the "Output" icon at the bottom of this window';
            }
        }

        editorModel?.setValue(msg);

        // restore a previous scroll if there was one
        if (this.previousScroll) {
            this.editor.setScrollTop(this.previousScroll);
            this.previousScroll = null;
        }

        if (!this.awaitingInitialResults) {
            if (this.selection) {
                this.editor.setSelection(this.selection);
                this.editor.revealLinesInCenter(this.selection.startLineNumber, this.selection.endLineNumber);
            }
            this.awaitingInitialResults = true;
        } else {
            const visibleRanges = this.editor.getVisibleRanges();
            const currentTopLine = visibleRanges.length > 0 ? visibleRanges[0].startLineNumber : 1;
            this.editor.revealLine(currentTopLine);
        }

        this.decorations.labelUsages = [];
        this.assembly.forEach((obj, line) => {
            if (!obj.labels || !obj.labels.length) return;

            obj.labels.forEach(label => {
                this.decorations.labelUsages.push({
                    range: new monaco.Range(line + 1, label.range.startCol, line + 1, label.range.endCol),
                    options: {
                        inlineClassName: 'asm-label-link',
                        hoverMessage: [
                            {
                                value: 'Ctrl + Left click to follow the label',
                            },
                        ],
                    },
                });
            });
        });
        this.updateDecorations();

        const codeLenses: monaco.languages.CodeLens[] = [];
        const effectiveFilters = this.getEffectiveFilters();
        if (effectiveFilters.binary || effectiveFilters.binaryObject || result.forceBinaryView) {
            this.setBinaryMargin();
            this.assembly.forEach((obj, line) => {
                if (obj.opcodes) {
                    const address = obj.address ? obj.address.toString(16) : '';
                    codeLenses.push({
                        range: {
                            startLineNumber: line + 1,
                            startColumn: 1,
                            endLineNumber: line + 2,
                            endColumn: 1,
                        },
                        id: address,
                        command: {
                            title: obj.opcodes.join(' '),
                        } as any, // This any cast fixes a bug
                    });
                }
            });
        } else {
            this.setNormalMargin();
        }

        if (this.settings.enableCodeLens) {
            if (editorModel) {
                codeLensHandler.registerLensesForCompiler(this.id, editorModel, codeLenses);

                const currentAsmLang = editorModel.getLanguageId();
                codeLensHandler.registerProviderForLanguage(currentAsmLang);
            }
        } else {
            // Make sure the codelens is disabled
            codeLensHandler.unregister(this.id);
        }
    }

    private errorResult(text: string): CompilationResult {
        return {timedOut: false, asm: this.fakeAsm(text), code: -1, stdout: [], stderr: []};
    }

    // TODO: Figure out if this is ResultLine or Assembly
    private fakeAsm(text: string): ResultLine[] {
        return [{text: text, fake: true} as ResultLine];
    }

    doNextCompileRequest(): void {
        if (this.nextRequest) {
            const next = this.nextRequest;
            this.nextRequest = null;
            this.sendCompile(next);
        }
    }

    doNextCMakeRequest(): void {
        if (this.nextCMakeRequest) {
            const next = this.nextCMakeRequest;
            this.nextCMakeRequest = null;
            this.sendCMakeCompile(next);
        }
    }

    onCMakeResponse(request: any, result: any, cached: boolean) {
        result.source = this.source;
        this.lastResult = result;
        const timeTaken = Math.max(0, Date.now() - this.pendingCMakeRequestSentAt);
        this.lastTimeTaken = timeTaken;
        const wasRealReply = this.pendingCMakeRequestSentAt > 0;
        this.pendingCMakeRequestSentAt = 0;

        this.handleCompileRequestAndResult(request, result, cached, wasRealReply, timeTaken);

        this.doNextCMakeRequest();
    }

    handleCompileRequestAndResult(
        request: any,
        result: any,
        cached: boolean,
        wasRealReply: boolean,
        timeTaken: number,
    ) {
        // Delete trailing empty lines
        if (Array.isArray(result.asm)) {
            const indexToDiscard = _.findLastIndex(result.asm, line => {
                return !_.isEmpty(line.text);
            });
            result.asm.splice(indexToDiscard + 1, result.asm.length - indexToDiscard);
        }

        this.labelDefinitions = result.labelDefinitions || {};
        if (result.asm) {
            this.setAssembly(result, result.filteredCount || 0);
        } else if (result.result?.asm) {
            this.setAssembly(result.result, result.result.filteredCount || 0);
        } else {
            result.asm = this.fakeAsm('<Compilation failed>');
            this.setAssembly(result, 0);
        }

        let stdout = result.stdout || [];
        let stderr = result.stderr || [];
        let failed: boolean = result.code ? result.code !== 0 : false;

        if (result.buildsteps) {
            result.buildsteps.forEach(step => {
                stdout = stdout.concat(step.stdout || []);
                stderr = stderr.concat(step.stderr || []);
                failed = failed || step.code !== 0;
            });
        }

        this.outputTextCount.text(stdout.length);
        this.outputErrorCount.text(stderr.length);
        if (this.isOutputOpened || (stdout.length === 0 && stderr.length === 0)) {
            this.outputBtn.prop('title', '');
        } else {
            CompilerService.handleOutputButtonTitle(this.outputBtn, result);
        }
        let infoLabelText = '';
        if (cached) {
            infoLabelText = ' - cached';
        } else if (wasRealReply) {
            infoLabelText = ' - ' + timeTaken + 'ms';
        }

        if (result.asmSize) {
            infoLabelText += ' (' + result.asmSize + 'B)';
        }

        if (result.filteredCount && result.filteredCount > 0) {
            infoLabelText +=
                ' ~' + result.filteredCount + (result.filteredCount === 1 ? ' line' : ' lines') + ' filtered';
        }

        this.compileInfoLabel.text(infoLabelText);

        if (result.result) {
            const wasCmake = result.buildsteps?.some(step => {
                return step.step === 'cmake';
            });
            this.postCompilationResult(request, result.result, wasCmake);
        } else {
            this.postCompilationResult(request, result);
        }

        if (
            this.compiler?.supportsDeviceAsmView &&
            !this.deviceViewOpen &&
            result.devices &&
            Object.keys(result.devices).length > 0
        ) {
            this.deviceButton.trigger('click');
        }

        if (this.compiler)
            this.eventHub.emit('compileResult', this.id, this.compiler, result, languages[this.currentLangId ?? '']);
    }

    onCompileResponse(request: any, result: any, cached: boolean): void {
        // Save which source produced this change. It should probably be saved earlier though
        result.source = this.source;
        this.lastResult = result;
        const timeTaken = Math.max(0, Date.now() - this.pendingRequestSentAt);
        this.lastTimeTaken = timeTaken;
        const wasRealReply = this.pendingRequestSentAt > 0;
        this.pendingRequestSentAt = 0;

        this.handleCompileRequestAndResult(request, result, cached, wasRealReply, timeTaken);

        this.doNextCompileRequest();
    }

    postCompilationResult(request: any, result: any, wasCmake?: boolean): void {
        if (result.popularArguments) {
            this.handlePopularArgumentsResult(result.popularArguments);
        } else if (this.compiler) {
            this.compilerService
                .requestPopularArguments(this.compiler.id, request.options.userArguments)
                .then((result: any) => {
                    if (result?.result) {
                        this.handlePopularArgumentsResult(result.result);
                    }
                })
                .catch(error => {
                    // Log the error but don't show to user - popular arguments are optional
                    console.warn('Failed to fetch popular arguments:', error);
                });
        }

        this.updateButtons();

        this.handleCompilationStatus(CompilerService.calculateStatusIcon(result));
        const warnings = this.checkForUnwiseArguments(result.compilationOptions, wasCmake ?? false);
        this.setCompilationOptionsPopover(
            result.compilationOptions ? result.compilationOptions.join(' ') : '',
            warnings,
        );

        this.checkForHints(result);

        this.offerFilesIfPossible(result);
    }

    offerFilesIfPossible(result: CompilationResult) {
        this.artifactHandler.handle(result);
    }

    onEditorChange(editor: number, source: string, langId: string, compilerId?: number): void {
        if (this.sourceTreeId) {
            const tree = this.hub.getTreeById(this.sourceTreeId);
            if (tree) {
                if (tree.multifileService.isEditorPartOfProject(editor)) {
                    if (this.settings.compileOnChange) {
                        this.compile();

                        return;
                    }
                }
            }
        }

        if (
            editor === this.sourceEditorId &&
            langId === this.currentLangId &&
            (compilerId === undefined || compilerId === this.id)
        ) {
            this.source = source;
            if (this.settings.compileOnChange) {
                this.compile();
            }
        }
    }

    onCompilerFlagsChange(compilerId: number, compilerFlags: string): void {
        if (compilerId === this.id) {
            this.onOptionsChange(compilerFlags);
        }
    }

    onToolOpened(compilerId: number, toolSettings: NewToolSettings): void {
        if (this.id === compilerId) {
            const toolId = toolSettings.toolId;

            const buttons = this.toolsMenu?.find('button');
            if (buttons)
                $(buttons).each((idx, button) => {
                    const toolButton = $(button);
                    const toolName = toolButton.data('toolname');
                    if (toolId === toolName) {
                        toolButton.prop('disabled', true);
                    }
                });

            this.compile(false, toolSettings);
        }
    }

    onToolClosed(compilerId: number, toolSettings: any): void {
        if (this.id === compilerId) {
            const toolId = toolSettings.toolId;

            const buttons = this.toolsMenu?.find('button');
            if (buttons)
                $(buttons).each((idx, button) => {
                    const toolButton = $(button);
                    const toolName = toolButton.data('toolname');
                    if (toolId === toolName) {
                        toolButton.prop('disabled', !this.supportsTool(toolId));
                    }
                });
        }
    }

    onOutputOpened(compilerId: number): void {
        if (this.id === compilerId) {
            this.isOutputOpened = true;
            this.outputBtn.prop('disabled', true);
            this.resendResult();
        }
    }

    onOutputClosed(compilerId: number): void {
        if (this.id === compilerId) {
            this.isOutputOpened = false;
            this.outputBtn.prop('disabled', false);
        }
    }

    onOptViewClosed(id: number): void {
        if (this.id === id) {
            this.wantOptInfo = false;
            this.optViewOpen = false;
            this.optButton.prop('disabled', this.optViewOpen);
        }
    }
    onStackUsageViewClosed(id: number): void {
        if (this.id === id) {
            this.stackUsageViewOpen = false;
            this.stackUsageButton.prop('disabled', this.stackUsageViewOpen);
        }
    }

    onFlagsViewClosed(id: number, compilerFlags: string): void {
        if (this.id === id) {
            this.flagsViewOpen = false;
            this.optionsField.val(compilerFlags);
            this.optionsField.prop('disabled', this.flagsViewOpen);
            this.optionsField.prop('placeholder', this.initialOptionsFieldPlacehoder);
            this.flagsButton?.prop('disabled', this.flagsViewOpen);

            this.compilerService
                .requestPopularArguments(this.compiler?.id ?? '', compilerFlags)
                .then((result: any) => {
                    if (result?.result) {
                        this.handlePopularArgumentsResult(result.result);
                    }
                })
                .catch(error => {
                    // Log the error but don't show to user - popular arguments are optional
                    console.warn('Failed to fetch popular arguments:', error);
                });

            this.updateState();
        }
    }

    onCompilerOverridesChange(): void {
        this.updateState();

        if (this.settings.compileOnChange) {
            this.compile();
        }
    }

    onToolSettingsChange(id: number): void {
        if (this.id === id) {
            this.compile();
        }
    }

    onPpViewOpened(id: number): void {
        if (this.id === id) {
            this.ppButton.prop('disabled', true);
            this.ppViewOpen = true;
            // the pp view will request compilation once it populates its options so this.compile() is not called here
        }
    }

    onPpViewClosed(id: number): void {
        if (this.id === id) {
            this.ppButton.prop('disabled', false);
            this.ppViewOpen = false;
        }
    }

    onPpViewOptionsUpdated(id: number, options: PPOptions, reqCompile?: boolean): void {
        if (this.id === id) {
            this.ppOptions = options;
            if (reqCompile) {
                this.compile();
            }
        }
    }

    onAstViewOpened(id: number): void {
        if (this.id === id) {
            this.astButton.prop('disabled', true);
            this.astViewOpen = true;
            this.compile();
        }
    }

    onAstViewClosed(id: number): void {
        if (this.id === id) {
            this.astButton.prop('disabled', false);
            this.astViewOpen = false;
        }
    }

    onIrViewOpened(id: number): void {
        if (this.id === id) {
            this.irButton.prop('disabled', true);
            this.irViewOpen = true;
            this.updateDebugCallsFilter();
            this.compile();
        }
    }

    onIrViewClosed(id: number): void {
        if (this.id === id) {
            this.irButton.prop('disabled', false);
            this.irViewOpen = false;
            this.updateDebugCallsFilter();
        }
    }

    onClangirViewOpened(id: number): void {
        if (this.id === id) {
            this.clangirButton.prop('disabled', true);
            this.clangirViewOpen = true;
            this.compile();
        }
    }

    onClangirViewClosed(id: number): void {
        if (this.id === id) {
            this.clangirButton.prop('disabled', false);
            this.clangirViewOpen = false;
        }
    }

    onLLVMIrViewOptionsUpdated(id: number, options: LLVMIrBackendOptions, recompile: boolean): void {
        if (this.id === id) {
            this.llvmIrOptions = options;
            if (recompile) {
                this.compile();
            }
        }
    }

    onClangirViewOptionsUpdated(id: number, options: ClangirBackendOptions, recompile: boolean): void {
        if (this.id === id) {
            this.clangirOptions = options;
            if (recompile) {
                this.compile();
            }
        }
    }

    onOptPipelineViewOpened(id: number): void {
        if (this.id === id) {
            this.optPipelineViewOpenCount++;
            this.compile();
        }
    }

    onOptPipelineViewClosed(id: number): void {
        if (this.id === id) {
            this.optPipelineViewOpenCount--;
        }
    }

    onOptPipelineViewOptionsUpdated(id: number, options: OptPipelineBackendOptions, recompile: boolean): void {
        if (this.id === id) {
            this.optPipelineOptions = options;
            if (recompile) {
                this.compile();
            }
        }
    }

    onDeviceViewOpened(id: number): void {
        if (this.id === id) {
            this.deviceButton.prop('disabled', true);
            this.deviceViewOpen = true;
            this.updateState();
            this.compile();
        }
    }

    onDeviceViewClosed(id: number): void {
        if (this.id === id) {
            this.deviceButton.prop('disabled', false);
            this.deviceViewOpen = false;
            this.updateState();
        }
    }

    onRustMirViewOpened(id: number): void {
        if (this.id === id) {
            this.rustMirButton.prop('disabled', true);
            this.rustMirViewOpen = true;
            this.compile();
        }
    }

    onRustMirViewClosed(id: number): void {
        if (this.id === id) {
            this.rustMirButton.prop('disabled', false);
            this.rustMirViewOpen = false;
        }
    }

    onHaskellCoreViewOpened(id: number): void {
        if (this.id === id) {
            this.haskellCoreButton.prop('disabled', true);
            this.haskellCoreViewOpen = true;
            this.compile();
        }
    }

    onHaskellCoreViewClosed(id: number): void {
        if (this.id === id) {
            this.haskellCoreButton.prop('disabled', false);
            this.haskellCoreViewOpen = false;
        }
    }

    onHaskellStgViewOpened(id: number): void {
        if (this.id === id) {
            this.haskellStgButton.prop('disabled', true);
            this.haskellStgViewOpen = true;
            this.compile();
        }
    }

    onHaskellStgViewClosed(id: number): void {
        if (this.id === id) {
            this.haskellStgButton.prop('disabled', false);
            this.haskellStgViewOpen = false;
        }
    }

    onHaskellCmmViewOpened(id: number): void {
        if (this.id === id) {
            this.haskellCmmButton.prop('disabled', true);
            this.haskellCmmViewOpen = true;
            this.compile();
        }
    }

    onHaskellCmmViewClosed(id: number): void {
        if (this.id === id) {
            this.haskellCmmButton.prop('disabled', false);
            this.haskellCmmViewOpen = false;
        }
    }

    onGnatDebugTreeViewOpened(id: number): void {
        if (this.id === id) {
            this.gnatDebugTreeButton.prop('disabled', true);
            this.gnatDebugTreeViewOpen = true;
            this.compile();
        }
    }

    onGnatDebugTreeViewClosed(id: number): void {
        if (this.id === id) {
            this.gnatDebugTreeButton.prop('disabled', false);
            this.gnatDebugTreeViewOpen = false;
        }
    }

    onGnatDebugViewOpened(id: number): void {
        if (this.id === id) {
            this.gnatDebugButton.prop('disabled', true);
            this.gnatDebugViewOpen = true;
            this.compile();
        }
    }

    onGnatDebugViewClosed(id: number): void {
        if (this.id === id) {
            this.gnatDebugButton.prop('disabled', false);
            this.gnatDebugViewOpen = false;
        }
    }

    onRustMacroExpViewOpened(id: number): void {
        if (this.id === id) {
            this.rustMacroExpButton.prop('disabled', true);
            this.rustMacroExpViewOpen = true;
            this.compile();
        }
    }

    onRustMacroExpViewClosed(id: number): void {
        if (this.id === id) {
            this.rustMacroExpButton.prop('disabled', false);
            this.rustMacroExpViewOpen = false;
        }
    }

    onRustHirViewOpened(id: number): void {
        if (this.id === id) {
            this.rustHirButton.prop('disabled', true);
            this.rustHirViewOpen = true;
            this.compile();
        }
    }

    onRustHirViewClosed(id: number): void {
        if (this.id === id) {
            this.rustHirButton.prop('disabled', false);
            this.rustHirViewOpen = false;
        }
    }

    onGccDumpUIInit(id: number): void {
        if (this.id === id) {
            this.compile();
        }
    }

    onGccDumpFiltersChanged(id: number, dumpOpts: GccDumpFiltersState, reqCompile: boolean): void {
        if (this.id === id) {
            this.treeDumpEnabled = dumpOpts.treeDump;
            this.rtlDumpEnabled = dumpOpts.rtlDump;
            this.ipaDumpEnabled = dumpOpts.ipaDump;
            this.dumpFlags = {
                gimpleFe: dumpOpts.gimpleFeOption,
                address: dumpOpts.addressOption,
                slim: dumpOpts.slimOption,
                raw: dumpOpts.rawOption,
                details: dumpOpts.detailsOption,
                stats: dumpOpts.statsOption,
                blocks: dumpOpts.blocksOption,
                vops: dumpOpts.vopsOption,
                lineno: dumpOpts.linenoOption,
                uid: dumpOpts.uidOption,
                all: dumpOpts.allOption,
            };

            if (reqCompile) {
                this.compile();
            }
        }
    }

    onGccDumpPassSelected(id: number, passObject?: GccDumpViewSelectedPass, reqCompile?: boolean) {
        if (this.id === id) {
            this.gccDumpPassSelected = passObject;

            if (reqCompile && passObject != null) {
                this.compile();
            }
        }
    }

    onGccDumpViewOpened(id: number): void {
        if (this.id === id) {
            this.gccDumpButton.prop('disabled', true);
            this.gccDumpViewOpen = true;
        }
    }

    onGccDumpViewClosed(id: number): void {
        if (this.id === id) {
            this.gccDumpButton.prop('disabled', !this.compiler?.supportsGccDump);
            this.gccDumpViewOpen = false;

            delete this.gccDumpPassSelected;
            delete this.treeDumpEnabled;
            delete this.rtlDumpEnabled;
            delete this.ipaDumpEnabled;
            delete this.dumpFlags;
        }
    }

    onOptViewOpened(id: number): void {
        if (this.id === id) {
            this.optViewOpen = true;
            this.wantOptInfo = true;
            this.optButton.prop('disabled', this.optViewOpen);
            this.compile();
        }
    }
    onStackUsageViewOpened(id: number): void {
        if (this.id === id) {
            this.stackUsageViewOpen = true;
            this.stackUsageButton.prop('disabled', this.stackUsageViewOpen);
            this.compile();
        }
    }

    onFlagsViewOpened(id: number): void {
        if (this.id === id) {
            this.flagsViewOpen = true;
            this.handlePopularArgumentsResult(null);
            this.optionsField.prop('disabled', this.flagsViewOpen);
            this.optionsField.val('');
            this.optionsField.prop('placeholder', 'see detailed flags window');
            this.flagsButton?.prop('disabled', this.flagsViewOpen);
            this.compile();
            this.updateState();
        }
    }

    onCfgViewOpened(id: number, isircfg: boolean): void {
        if (this.id === id) {
            this.cfgViewOpenCount++;
            if (isircfg) {
                this.irCfgViewOpenCount++;
            }
            this.compile();
        }
    }

    onCfgViewClosed(id: number, isircfg: boolean): void {
        if (this.id === id) {
            this.cfgViewOpenCount--;
            if (isircfg) {
                this.irCfgViewOpenCount--;
            }
            if (this.irCfgViewOpenCount < 0) {
                // sometinhg has gone terribly wrong
                this.irCfgViewOpenCount = 0;
            }
        }
    }

    initFilterButtons(): void {
        this.filterBinaryObjectButton = this.domRoot.find("[data-bind='binaryObject']");
        this.filterBinaryObjectTitle = this.filterBinaryObjectButton.prop('title');

        this.filterBinaryButton = this.domRoot.find("[data-bind='binary']");
        this.filterBinaryTitle = this.filterBinaryButton.prop('title');

        this.filterExecuteButton = this.domRoot.find("[data-bind='execute']");
        this.filterExecuteTitle = this.filterExecuteButton.prop('title');

        this.filterLabelsButton = this.domRoot.find("[data-bind='labels']");
        this.filterLabelsTitle = this.filterLabelsButton.prop('title');

        this.filterDirectivesButton = this.domRoot.find("[data-bind='directives']");
        this.filterDirectivesTitle = this.filterDirectivesButton.prop('title');

        this.filterLibraryCodeButton = this.domRoot.find("[data-bind='libraryCode']");
        this.filterLibraryCodeTitle = this.filterLibraryCodeButton.prop('title');

        this.filterCommentsButton = this.domRoot.find("[data-bind='commentOnly']");
        this.filterCommentsTitle = this.filterCommentsButton.prop('title');

        this.filterTrimButton = this.domRoot.find("[data-bind='trim']");
        this.filterTrimTitle = this.filterTrimButton.prop('title');

        this.filterDebugCallsButton = this.domRoot.find("[data-bind='debugCalls']");
        this.filterDebugCallsTitle = this.filterDebugCallsButton.prop('title');

        this.filterIntelButton = this.domRoot.find("[data-bind='intel']");
        this.filterIntelTitle = this.filterIntelButton.prop('title');

        this.filterDemangleButton = this.domRoot.find("[data-bind='demangle']");
        this.filterDemangleTitle = this.filterDemangleButton.prop('title');

        this.filterVerboseDemanglingButton = this.domRoot.find("[data-bind='verboseDemangling']");
        this.filterVerboseDemanglingTitle = this.filterVerboseDemanglingButton.prop('title');

        this.noBinaryFiltersButtons = this.domRoot.find('.nonbinary');
    }

    override registerButtons(state: CompilerCurrentState) {
        super.registerButtons(state);
        this.filters = new Toggles(this.domRoot.find('.filters'), patchOldFilters(state.filters));

        this.optButton = this.domRoot.find('.btn.view-optimization');
        this.stackUsageButton = this.domRoot.find('.btn.view-stack-usage');
        this.flagsButton = this.domRoot.find('div.populararguments div.dropdown-menu button');
        this.ppButton = this.domRoot.find('.btn.view-pp');
        this.astButton = this.domRoot.find('.btn.view-ast');
        this.irButton = this.domRoot.find('.btn.view-ir');
        this.clangirButton = this.domRoot.find('.btn.view-clangir');
        this.optPipelineButton = this.domRoot.find('.btn.view-opt-pipeline');
        this.deviceButton = this.domRoot.find('.btn.view-device');
        this.gnatDebugTreeButton = this.domRoot.find('.btn.view-gnatdebugtree');
        this.gnatDebugButton = this.domRoot.find('.btn.view-gnatdebug');
        this.rustMirButton = this.domRoot.find('.btn.view-rustmir');
        this.rustMacroExpButton = this.domRoot.find('.btn.view-rustmacroexp');
        this.rustHirButton = this.domRoot.find('.btn.view-rusthir');
        this.haskellCoreButton = this.domRoot.find('.btn.view-haskellCore');
        this.haskellStgButton = this.domRoot.find('.btn.view-haskellStg');
        this.haskellCmmButton = this.domRoot.find('.btn.view-haskellCmm');
        this.gccDumpButton = this.domRoot.find('.btn.view-gccdump');
        this.cfgButton = this.domRoot.find('.btn.view-cfg');
        this.executorButton = this.domRoot.find('.create-executor');
        this.libsButton = this.domRoot.find('.btn.show-libs');

        this.compileInfoLabel = this.domRoot.find('.compile-info');
        this.compileClearCache = this.domRoot.find('.clear-cache');

        this.outputBtn = this.domRoot.find('.output-btn');
        this.outputTextCount = this.domRoot.find('span.text-count');
        this.outputErrorCount = this.domRoot.find('span.err-count');

        this.optionsField = this.domRoot.find('.options');
        this.initialOptionsFieldPlacehoder = this.optionsField.prop('placeholder');
        this.prependOptions = this.domRoot.find('.prepend-options');
        this.fullCompilerName = this.domRoot.find('.full-compiler-name');
        this.fullTimingInfo = this.domRoot.find('.full-timing-info');
        this.compilerLicenseButton = this.domRoot.find('.compiler-license');
        this.setCompilationOptionsPopover(this.compiler ? this.compiler.options : null, []);

        this.initFilterButtons();

        this.filterExecuteButton.toggle(options.supportsExecute);
        this.filterLibraryCodeButton.toggle(options.supportsLibraryCodeFilter);

        this.optionsField.val(this.options);

        this.shortCompilerName = this.domRoot.find('.short-compiler-name');
        this.setCompilerVersionPopover();

        this.topBar = this.domRoot.find('.top-bar');
        this.bottomBar = this.domRoot.find('.bottom-bar');
        this.statusLabel = this.domRoot.find('.status-text');

        this.hideable = this.domRoot.find('.hideable');
        this.statusIcon = this.domRoot.find('.status-icon');

        $(this.domRoot).on('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && String.fromCharCode(event.which).toLowerCase() === 's') {
                event.preventDefault();
                if (this.assembly.length > 0) {
                    const texts = this.assembly.map(asm => asm.text ?? '');
                    const blob = new Blob([texts.join('\n')], {type: 'text/plain;charset=utf-8'});
                    const fileName = this.getLanguageName() + '-' + this.getCompilerName() + '-' + this.id + '.asm';
                    fileSaver.saveAs(blob, fileName);
                }
            }
        });
    }

    onLibsChanged(): void {
        this.updateState();
        this.compile();
    }

    initLibraries(state: WidgetState): void {
        this.libsWidget = new LibsWidget(
            this.currentLangId ?? '',
            this.compiler,
            this.libsButton,
            state,
            this.onLibsChanged.bind(this),
            LibUtils.getSupportedLibraries(
                this.compiler ? this.compiler.libsArr : [],
                this.currentLangId ?? '',
                this.compiler?.remote,
            ),
        );
    }

    updateLibraries(): void {
        if (this.libsWidget) {
            let filteredLibraries: LanguageLibs = {};
            if (this.compiler) {
                filteredLibraries = LibUtils.getSupportedLibraries(
                    this.compiler.libsArr,
                    this.currentLangId ?? '',
                    this.compiler.remote,
                );
            }

            this.libsWidget.setNewLangId(this.currentLangId ?? '', this.compiler?.id ?? '', filteredLibraries);
        }
    }

    isSupportedTool(tool: Tool): boolean {
        if (this.sourceTreeId) {
            return tool.tool.type === 'postcompilation';
        }
        return true;
    }

    supportsTool(toolId: string): boolean {
        if (!this.compiler) return false;

        return !!Object.values(this.compiler.tools).find(tool => {
            return tool.tool.id === toolId && this.isSupportedTool(tool);
        });
    }

    initToolButton(hideToolDropdown: () => void, button: JQuery<HTMLElement>, toolId: string): void {
        const createToolView = () => {
            let args = '';
            let monacoStdin = false;
            const langTools = options.tools[this.currentLangId ?? ''];
            if (langTools?.[toolId]?.tool) {
                if (langTools[toolId].tool.args !== undefined) {
                    args = langTools[toolId].tool.args;
                }
                if (langTools[toolId].tool.monacoStdin !== undefined) {
                    monacoStdin = langTools[toolId].tool.monacoStdin;
                }
            }
            return Components.getToolViewWith(
                this.id,
                this.getCompilerName(),
                this.sourceEditorId ?? 0,
                toolId,
                args,
                monacoStdin,
                this.sourceTreeId ?? 0,
            );
        };

        createDragSource(this.container.layoutManager, button, () => createToolView()).on(
            'dragStart',
            hideToolDropdown,
        );

        button.on('click', () => {
            button.prop('disabled', true);
            const insertPoint =
                this.hub.findParentRowOrColumn(this.container.parent) ||
                this.container.layoutManager.root.contentItems[0];
            insertPoint.addChild(createToolView());
        });
        button.addClass('new-pane-button');
    }

    initToolButtons(): void {
        this.toolsMenu = this.domRoot.find('.new-tool-dropdown');
        const hideToolDropdown = () => {
            if (this.toolsMenu) BootstrapUtils.hideDropdown(this.toolsMenu);
        };
        this.toolsMenu.empty();

        if (!this.compiler) return;

        const addTool = (toolName: string, title: string, toolIcon?: string, toolIconDark?: string) => {
            const btn = $("<button class='dropdown-item btn btn-light btn-sm'>");
            btn.addClass('view-' + toolName);
            btn.data('toolname', toolName);
            if (toolIcon) {
                const toolIconFull = getStaticImage(toolIcon, 'logos');
                // If there is a dark icon, we use it, otherwise we use the light icon
                const toolIconDarkFull =
                    toolIconDark !== undefined ? getStaticImage(toolIconDark, 'logos') : toolIconFull;
                btn.append(
                    `
                    <span class="dropdown-icon fas">
                      <img src="${toolIconFull}" class="theme-light-only" width="16px" style="max-height: 16px"/>
                      <img src="${toolIconDarkFull}" class="theme-dark-only" width="16px" style="max-height: 16px"/>
                    </span>
                    `,
                );
            } else {
                btn.append("<span class='dropdown-icon fas fa-cog'></span>");
            }
            btn.append(title);
            this.toolsMenu?.append(btn);

            if (toolName !== 'none') {
                this.initToolButton(hideToolDropdown, btn, toolName);
            }
        };

        const tools = Object.values(this.compiler.tools);
        if (tools.length === 0) {
            addTool('none', 'No tools available');
        } else {
            tools.forEach(tool => {
                if (this.isSupportedTool(tool)) {
                    addTool(tool.tool.id, tool.tool.name || tool.tool.id, tool.tool.icon, tool.tool.darkIcon);
                }
            });
        }
    }

    enableToolButtons(): void {
        const activeTools = this.getActiveTools();

        const buttons = this.toolsMenu?.find('button');
        if (buttons)
            $(buttons).each((idx, button) => {
                const toolButton = $(button);
                const toolName = toolButton.data('toolname');
                toolButton.prop(
                    'disabled',
                    !(this.supportsTool(toolName) && !this.isToolActive(activeTools, toolName)),
                );
            });
    }

    updateButtons(): void {
        if (!this.compiler) return;
        const filters = this.getEffectiveFilters();
        // We can support intel output if the compiler supports it, or if we're compiling
        // to binary (as we can disassemble it however we like).
        const formatFilterTitle = (
            button: JQuery<HTMLElementTagNameMap[keyof HTMLElementTagNameMap]>,
            title: JQuery<HTMLElement>,
        ) => {
            button.prop(
                'title',
                '[' +
                    (button.hasClass('active') ? 'ON' : 'OFF') +
                    '] ' +
                    title +
                    (button.prop('disabled') ? ' [LOCKED]' : ''),
            );
        };
        const isIntelFilterDisabled = !this.compiler.supportsIntel && !filters.binary && !filters.binaryObject;
        this.filterIntelButton.prop('disabled', isIntelFilterDisabled);
        formatFilterTitle(this.filterIntelButton, this.filterIntelTitle);

        // Disable binaryObject support on compilers that don't work with it or if binary is selected
        this.filterBinaryObjectButton.prop('disabled', !this.compiler.supportsBinaryObject || filters.binary);
        formatFilterTitle(this.filterBinaryObjectButton, this.filterBinaryObjectTitle);

        // Disable binary support on compilers that don't work with it or if binaryObject is selected
        this.filterBinaryButton.prop('disabled', !this.compiler.supportsBinary || filters.binaryObject);
        formatFilterTitle(this.filterBinaryButton, this.filterBinaryTitle);

        this.filterExecuteButton.prop('disabled', !this.compiler.supportsBinary && !this.compiler.supportsExecute);
        formatFilterTitle(this.filterExecuteButton, this.filterExecuteTitle);
        // Disable demangle for compilers where we can't access it
        this.filterDemangleButton.prop('disabled', !this.compiler.supportsDemangle);
        formatFilterTitle(this.filterDemangleButton, this.filterDemangleTitle);

        // Disable verbose demangling when demangling is disabled
        this.filterVerboseDemanglingButton.prop(
            'disabled',
            !this.compiler.supportsVerboseDemangling || !filters.demangle,
        );
        formatFilterTitle(this.filterVerboseDemanglingButton, this.filterVerboseDemanglingTitle);

        // Disable any of the options which don't make sense in binary mode.
        const noBinaryFiltersDisabled =
            (filters.binaryObject || filters.binary) && !this.compiler.supportsFiltersInBinary;
        this.noBinaryFiltersButtons.prop('disabled', noBinaryFiltersDisabled);

        this.filterLibraryCodeButton.prop('disabled', !this.compiler.supportsLibraryCodeFilter);
        formatFilterTitle(this.filterLibraryCodeButton, this.filterLibraryCodeTitle);

        this.filterLabelsButton.prop('disabled', this.compiler.disabledFilters.includes('labels'));
        formatFilterTitle(this.filterLabelsButton, this.filterLabelsTitle);
        this.filterDirectivesButton.prop('disabled', this.compiler.disabledFilters.includes('directives'));
        formatFilterTitle(this.filterDirectivesButton, this.filterDirectivesTitle);
        this.filterCommentsButton.prop('disabled', this.compiler.disabledFilters.includes('commentOnly'));
        formatFilterTitle(this.filterCommentsButton, this.filterCommentsTitle);
        this.filterTrimButton.prop('disabled', this.compiler.disabledFilters.includes('trim'));
        formatFilterTitle(this.filterTrimButton, this.filterTrimTitle);
        this.updateDebugCallsFilter();
        formatFilterTitle(this.filterDebugCallsButton, this.filterDebugCallsTitle);

        if (this.flagsButton) {
            this.flagsButton.prop('disabled', this.flagsViewOpen);
        }
        this.optButton.prop('disabled', this.optViewOpen);
        this.ppButton.prop('disabled', this.ppViewOpen);
        this.astButton.prop('disabled', this.astViewOpen);
        this.irButton.prop('disabled', this.irViewOpen);
        this.clangirButton.prop('disabled', this.clangirViewOpen);
        // As per #4112, it's useful to have this available more than once: Don't disable it when it opens
        // this.optPipelineButton.prop('disabled', this.optPipelineViewOpen);
        this.deviceButton.prop('disabled', this.deviceViewOpen);
        this.rustMirButton.prop('disabled', this.rustMirViewOpen);
        this.haskellCoreButton.prop('disabled', this.haskellCoreViewOpen);
        this.haskellStgButton.prop('disabled', this.haskellStgViewOpen);
        this.haskellCmmButton.prop('disabled', this.haskellCmmViewOpen);
        this.rustMacroExpButton.prop('disabled', this.rustMacroExpViewOpen);
        this.rustHirButton.prop('disabled', this.rustHirViewOpen);
        this.gccDumpButton.prop('disabled', this.gccDumpViewOpen);
        this.gnatDebugTreeButton.prop('disabled', this.gnatDebugTreeViewOpen);
        this.gnatDebugButton.prop('disabled', this.gnatDebugViewOpen);
        // The executorButton does not need to be changed here, because you can create however
        // many executors as you want.

        this.optButton.toggle(!!this.compiler.supportsOptOutput);
        this.stackUsageButton.toggle(!!this.compiler.supportsStackUsageOutput);
        this.ppButton.toggle(!!this.compiler.supportsPpView);
        this.astButton.toggle(!!this.compiler.supportsAstView);
        this.irButton.toggle(!!this.compiler.supportsIrView);
        this.clangirButton.toggle(!!this.compiler.supportsClangirView);
        this.optPipelineButton.toggle(!!this.compiler.optPipeline);
        this.deviceButton.toggle(!!this.compiler.supportsDeviceAsmView);
        this.rustMirButton.toggle(!!this.compiler.supportsRustMirView);
        this.rustMacroExpButton.toggle(!!this.compiler.supportsRustMacroExpView);
        this.rustHirButton.toggle(!!this.compiler.supportsRustHirView);
        this.haskellCoreButton.toggle(!!this.compiler.supportsHaskellCoreView);
        this.haskellStgButton.toggle(!!this.compiler.supportsHaskellStgView);
        this.haskellCmmButton.toggle(!!this.compiler.supportsHaskellCmmView);
        // TODO(jeremy-rifkin): Disable cfg button when binary mode is set?
        this.cfgButton.toggle(!!this.compiler.supportsCfg);
        this.gccDumpButton.toggle(!!this.compiler.supportsGccDump);
        this.gnatDebugTreeButton.toggle(!!this.compiler.supportsGnatDebugViews);
        this.gnatDebugButton.toggle(!!this.compiler.supportsGnatDebugViews);
        this.executorButton.toggle(this.compiler.supportsBinary || this.compiler.supportsExecute);
        this.filterBinaryButton.toggle(!!this.compiler.supportsBinary);
        this.filterBinaryObjectButton.toggle(!!this.compiler.supportsBinaryObject);
        this.filterVerboseDemanglingButton.toggle(!!this.compiler.supportsVerboseDemangling);

        this.compilerLicenseButton.toggle(!!this.hasCompilerLicenseInfo());

        this.enableToolButtons();
    }

    updateDebugCallsFilter(): void {
        if (!this.compiler) return;
        let enable = false;
        if (!this.compiler.disabledFilters.includes('debugCalls')) {
            if (this.compiler.minIrArgs) enable ||= this.compiler.minIrArgs.some(value => this.options.includes(value));
            if (this.compiler.irArg) enable ||= this.options.includes(this.compiler.irArg.join(' '));
            enable ||= this.irViewOpen;
            enable ||= this.compiler.lang === 'llvm';
        }
        this.filterDebugCallsButton.prop('disabled', !enable);
    }

    hasCompilerLicenseInfo(): string | undefined {
        return (
            this.compiler?.license &&
            (this.compiler.license.preamble || this.compiler.license.link || this.compiler.license.name)
        );
    }

    handlePopularArgumentsResult(result: Record<string, {description: string}> | null): void {
        const popularArgumentsMenu = $(this.domRoot.find('div.populararguments div.dropdown-menu'));

        while (popularArgumentsMenu.children().length > 1) {
            popularArgumentsMenu.children()[1].remove();
        }

        if (result && !this.flagsViewOpen) {
            Object.entries(result).forEach(([key, arg]) => {
                const argumentButton = $(document.createElement('button'));
                argumentButton.addClass('dropdown-item btn btn-light btn-sm');
                argumentButton.attr('title', arg.description);
                argumentButton.data('arg', key);
                argumentButton.html(
                    "<div class='argmenuitem'>" +
                        "<span class='argtitle'>" +
                        escapeHTML(key + '') +
                        '</span>' +
                        "<span class='argdescription'>" +
                        arg.description +
                        '</span>' +
                        '</div>',
                );

                argumentButton.on('click', () => {
                    const button = argumentButton;
                    const curOptions = unwrapString(this.optionsField.val());
                    if (curOptions && curOptions.length > 0) {
                        this.optionsField.val(curOptions + ' ' + button.data('arg'));
                    } else {
                        this.optionsField.val(button.data('arg'));
                    }

                    this.optionsField.change();
                });

                popularArgumentsMenu.append(argumentButton);
            });
        }
    }

    generateLicenseInfo(): string {
        if (this.compiler) {
            // MSVC will take a while to add this
            if (!this.compiler.license) {
                return 'No license information to display for ' + this.compiler.name;
            }
            let result = '';
            const preamble = this.compiler.license.preamble;
            if (preamble) {
                result += preamble + '<br/>';
            }
            const name = this.compiler.license.name;
            const link = this.compiler.license.link;

            if (name || link) {
                result += this.compiler.name + ' is licensed under ';

                if (link) {
                    const aText = name ? name : link;
                    result += '<a href="' + link + '" target="_blank">' + aText + '</a>';
                } else {
                    result += name;
                }
            }

            if (!result) {
                result = 'No license information to display for ' + this.compiler.name;
            } else {
                result +=
                    '<div><p>If the displayed information is wrong, please submit an issue to ' +
                    '<a href="https://github.com/compiler-explorer/compiler-explorer/issues/new?assignees=&labels=bug&template=bug_report.yml&title=%5BBUG%5D%3A' +
                    encodeURIComponent(this.compiler.name + ' license is wrong') +
                    '" target="_blank">https://github.com/compiler-explorer/compiler-explorer/issues</a></p></div>';
            }

            return result;
        }
        return 'No compiler selected';
    }

    onFontScale(): void {
        this.updateState();
    }

    // Disable only for registerCallbacks as there are more and more callbacks.

    override registerCallbacks(): void {
        this.container.on('shown', this.resize, this);
        this.container.on('open', () => {
            this.eventHub.emit('compilerOpen', this.id, this.sourceEditorId ?? 0, this.sourceTreeId ?? 0);
        });
        this.eventHub.on('editorChange', this.onEditorChange, this);
        this.eventHub.on('compilerFlagsChange', this.onCompilerFlagsChange, this);
        this.eventHub.on('editorClose', this.onEditorClose, this);
        this.eventHub.on('treeClose', this.onTreeClose, this);
        this.eventHub.on('colours', this.onColours, this);
        this.eventHub.on('coloursForCompiler', this.onColoursForCompiler, this);
        this.eventHub.on('resendCompilation', this.onResendCompilation, this);
        this.eventHub.on('findCompilers', this.sendCompiler, this);
        this.eventHub.on('compilerSetDecorations', this.onCompilerSetDecorations, this);
        this.eventHub.on('panesLinkLine', this.onPanesLinkLine, this);
        this.eventHub.on('requestCompilation', this.onRequestCompilation, this);

        this.eventHub.on('toolSettingsChange', this.onToolSettingsChange, this);
        this.eventHub.on('toolOpened', this.onToolOpened, this);
        this.eventHub.on('toolClosed', this.onToolClosed, this);

        this.eventHub.on('optViewOpened', this.onOptViewOpened, this);
        this.eventHub.on('optViewClosed', this.onOptViewClosed, this);
        this.eventHub.on('stackUsageViewOpened', this.onStackUsageViewOpened, this);
        this.eventHub.on('stackUsageViewClosed', this.onStackUsageViewClosed, this);
        this.eventHub.on('flagsViewOpened', this.onFlagsViewOpened, this);
        this.eventHub.on('flagsViewClosed', this.onFlagsViewClosed, this);
        this.eventHub.on('ppViewOpened', this.onPpViewOpened, this);
        this.eventHub.on('ppViewClosed', this.onPpViewClosed, this);
        this.eventHub.on('ppViewOptionsUpdated', this.onPpViewOptionsUpdated, this);
        this.eventHub.on('astViewOpened', this.onAstViewOpened, this);
        this.eventHub.on('astViewClosed', this.onAstViewClosed, this);
        this.eventHub.on('irViewOpened', this.onIrViewOpened, this);
        this.eventHub.on('irViewClosed', this.onIrViewClosed, this);
        this.eventHub.on('clangirViewOpened', this.onClangirViewOpened, this);
        this.eventHub.on('clangirViewClosed', this.onClangirViewClosed, this);
        this.eventHub.on('llvmIrViewOptionsUpdated', this.onLLVMIrViewOptionsUpdated, this);
        this.eventHub.on('clangirViewOptionsUpdated', this.onClangirViewOptionsUpdated, this);
        this.eventHub.on('optPipelineViewOpened', this.onOptPipelineViewOpened, this);
        this.eventHub.on('optPipelineViewClosed', this.onOptPipelineViewClosed, this);
        this.eventHub.on('optPipelineViewOptionsUpdated', this.onOptPipelineViewOptionsUpdated, this);
        this.eventHub.on('deviceViewOpened', this.onDeviceViewOpened, this);
        this.eventHub.on('deviceViewClosed', this.onDeviceViewClosed, this);
        this.eventHub.on('rustMirViewOpened', this.onRustMirViewOpened, this);
        this.eventHub.on('rustMirViewClosed', this.onRustMirViewClosed, this);
        this.eventHub.on('rustMacroExpViewOpened', this.onRustMacroExpViewOpened, this);
        this.eventHub.on('rustMacroExpViewClosed', this.onRustMacroExpViewClosed, this);
        this.eventHub.on('rustHirViewOpened', this.onRustHirViewOpened, this);
        this.eventHub.on('rustHirViewClosed', this.onRustHirViewClosed, this);
        this.eventHub.on('haskellCoreViewOpened', this.onHaskellCoreViewOpened, this);
        this.eventHub.on('haskellCoreViewClosed', this.onHaskellCoreViewClosed, this);
        this.eventHub.on('haskellStgViewOpened', this.onHaskellStgViewOpened, this);
        this.eventHub.on('haskellStgViewClosed', this.onHaskellStgViewClosed, this);
        this.eventHub.on('haskellCmmViewOpened', this.onHaskellCmmViewOpened, this);
        this.eventHub.on('haskellCmmViewClosed', this.onHaskellCmmViewClosed, this);
        this.eventHub.on('outputOpened', this.onOutputOpened, this);
        this.eventHub.on('outputClosed', this.onOutputClosed, this);

        this.eventHub.on('gccDumpPassSelected', this.onGccDumpPassSelected, this);
        this.eventHub.on('gccDumpFiltersChanged', this.onGccDumpFiltersChanged, this);
        this.eventHub.on('gccDumpViewOpened', this.onGccDumpViewOpened, this);
        this.eventHub.on('gccDumpViewClosed', this.onGccDumpViewClosed, this);
        this.eventHub.on('gccDumpUIInit', this.onGccDumpUIInit, this);

        this.eventHub.on('gnatDebugTreeViewOpened', this.onGnatDebugTreeViewOpened, this);
        this.eventHub.on('gnatDebugTreeViewClosed', this.onGnatDebugTreeViewClosed, this);
        this.eventHub.on('gnatDebugViewOpened', this.onGnatDebugViewOpened, this);
        this.eventHub.on('gnatDebugViewClosed', this.onGnatDebugViewClosed, this);

        this.eventHub.on('cfgViewOpened', this.onCfgViewOpened, this);
        this.eventHub.on('cfgViewClosed', this.onCfgViewClosed, this);
        this.eventHub.on('requestCompiler', id => {
            if (id === this.id) {
                this.sendCompiler();
            }
        });
        this.eventHub.on('languageChange', this.onLanguageChange, this);

        this.eventHub.on('initialised', this.undefer, this);

        // Dismiss on any click that isn't either in the opening element, inside
        // the popover or on any alert
        $(document).on('mouseup', e => {
            const target = $(e.target);
            if (
                !target.is(this.prependOptions) &&
                this.prependOptions.has(target as unknown as Element).length === 0 &&
                target.closest('.popover').length === 0
            )
                BootstrapUtils.hidePopover(this.prependOptions);

            if (
                !target.is(this.fullCompilerName) &&
                this.fullCompilerName.has(target as unknown as Element).length === 0 &&
                target.closest('.popover').length === 0
            )
                BootstrapUtils.hidePopover(this.fullCompilerName);
        });
    }

    initCallbacks(): void {
        this.filters.on('change', this.onFilterChange.bind(this));

        this.fullTimingInfo.off('click').on('click', () => {
            TimingWidget.displayCompilationTiming(this.lastResult, this.lastTimeTaken);
        });

        const optionsChange = _.debounce(e => {
            this.onOptionsChange(unwrapString($(e.target).val()));
        }, 800);

        this.optionsField.on('change', optionsChange).on('keyup', optionsChange);

        this.mouseMoveThrottledFunction = _.throttle(this.onMouseMove.bind(this), 50);
        this.editor.onMouseMove(e => {
            if (this.mouseMoveThrottledFunction) this.mouseMoveThrottledFunction(e);
        });

        this.cursorSelectionThrottledFunction = _.throttle(this.onDidChangeCursorSelection.bind(this), 500);
        this.editor.onDidChangeCursorSelection(e => {
            if (this.cursorSelectionThrottledFunction) this.cursorSelectionThrottledFunction(e);
        });

        this.mouseUpThrottledFunction = _.throttle(this.onMouseUp.bind(this), 50);
        this.editor.onMouseUp(e => {
            if (this.mouseUpThrottledFunction) this.mouseUpThrottledFunction(e);
        });

        this.compileClearCache.on('click', () => {
            this.compile(true);
        });

        this.compilerLicenseButton.on('click', () => {
            const title = this.compiler ? 'License for ' + this.compiler.name : 'No compiler selected';
            this.alertSystem.alert(title, this.generateLicenseInfo());
        });

        // Dismiss the popover on escape.
        $(document).on('keyup.editable', e => {
            if (e.which === 27) {
                BootstrapUtils.hidePopover(this.libsButton);
            }
        });

        // Dismiss on any click that isn't either in the opening element, inside
        // the popover or on any alert
        $(document).on('click', e => {
            const elem = this.libsButton;
            const target = $(e.target);
            if (
                !target.is(elem) &&
                elem.has(target as unknown as Element).length === 0 &&
                target.closest('.popover').length === 0
            ) {
                BootstrapUtils.hidePopover(elem);
            }
        });
    }

    onOptionsChange(options: string): void {
        if (this.options !== options) {
            this.options = options;
            this.updateState();
            this.compile();
            this.updateButtons();
            this.sendCompiler();
        }
    }

    private htmlEncode(rawStr: string): string {
        return rawStr.replace(/[\u00A0-\u9999<>&]/g, i => '&#' + i.charCodeAt(0) + ';');
    }

    checkForHints(result: {hints?: string[]}): void {
        if (result.hints) {
            result.hints.forEach(hint => {
                this.alertSystem.notify(this.htmlEncode(hint), {
                    group: 'hints',
                    collapseSimilar: false,
                });
            });
        }
    }

    checkForUnwiseArguments(optionsArray: string[] | undefined, wasCmake: boolean) {
        if (!this.compiler) return [];

        if (!optionsArray) optionsArray = [];

        // Check if any options are in the unwiseOptions array and remember them
        const unwiseOptions = _.intersection(
            optionsArray,
            this.compiler.unwiseOptions.filter(opt => {
                return opt !== '';
            }),
        );

        const options = unwiseOptions.length === 1 ? 'Option ' : 'Options ';
        const names = unwiseOptions.join(', ');
        const are = unwiseOptions.length === 1 ? ' is ' : ' are ';
        const msg = options + names + are + 'not recommended, as behaviour might change based on server hardware.';

        const warnings: string[] = [];

        if (optionsArray.some(opt => opt === '-flto') && !this.filters.isSet('binary') && !wasCmake) {
            warnings.push('Option -flto is being used without Link to Binary.');
        }

        if (unwiseOptions.length > 0) {
            warnings.push(msg);
        }

        return warnings;
    }

    updateCompilerInfo(): void {
        this.updateCompilerName();
        if (this.compiler) {
            if (this.compiler.notification.length > 0) {
                this.alertSystem.notify(this.compiler.notification, {
                    group: 'compilerwarning',
                    alertClass: 'notification-info',
                    dismissTime: 7000,
                });
            }
            this.prependOptions.data('content', this.compiler.options);
        }
    }

    updateCompilerUI(): void {
        this.initToolButtons();
        this.updateButtons();
        this.updateCompilerInfo();
        // Resize in case the new compiler name is too big
        this.resize();
    }

    onCompilerChange(value: string): void {
        this.compiler = this.compilerService.findCompiler(this.currentLangId ?? '', value);

        this.deferCompiles = true;
        this.needsCompile = true;

        this.updateLibraries();
        this.updateState();
        this.updateCompilerUI();

        this.undefer();

        this.sendCompiler();
    }

    sendCompiler(): void {
        this.eventHub.emit(
            'compiler',
            this.id,
            this.compiler,
            this.options,
            this.sourceEditorId ?? 0,
            this.sourceTreeId ?? 0,
        );
    }

    onEditorClose(editor: number): void {
        if (editor === this.sourceEditorId) {
            // We can't immediately close as an outer loop somewhere in GoldenLayout is iterating over
            // the hierarchy. We can't modify while it's being iterated over.
            this.close();
            _.defer(() => {
                this.container.close();
            });
        }
    }

    onTreeClose(tree: any): void {
        if (tree === this.sourceTreeId) {
            this.close();
            _.defer(() => {
                this.container.close();
            });
        }
    }

    onFilterChange(): void {
        this.updateState();
        this.compile();
        this.updateButtons();
    }

    // id is optional in CompilerCurrentState but not in MonacoPaneState, which the base class expects
    override getCurrentState(): CompilerCurrentState & MonacoPaneState {
        const parent = super.getCurrentState();
        const state: CompilerCurrentState & MonacoPaneState = {
            compilerName: parent.compilerName,
            editorid: parent.editorid,
            treeid: parent.treeid,
            id: this.id,
            compiler: this.compiler ? this.compiler.id : '',
            source: this.sourceEditorId ?? undefined,
            tree: this.sourceTreeId ?? undefined,
            options: this.options,
            // NB must *not* be effective filters
            filters: this.filters.get(),
            wantOptInfo: this.wantOptInfo,
            libs: this.libsWidget?.get(),
            lang: this.currentLangId ?? undefined,
            selection: this.selection,
            flagsViewOpen: this.flagsViewOpen,
            overrides: this.compilerShared.getOverrides(),
            runtimeTools: this.compilerShared.getRuntimeTools(),
        };
        this.paneRenaming.addState(state);
        this.fontScale.addState(state);
        return state;
    }

    onColours(editor: number, colours: Record<number, number>, scheme: string): void {
        const asmColours: Record<number, Record<number, number>> = {};
        this.assembly.forEach((x, index) => {
            if (x.source && x.source.line > 0) {
                const editorId = this.getEditorIdBySourcefile(x.source);
                if (typeof editorId === 'number' && editorId === editor) {
                    if (!asmColours[editorId]) {
                        asmColours[editorId] = {};
                    }
                    asmColours[editorId][index] = colours[x.source.line - 1];
                }
            }
        });

        Object.values(asmColours).forEach(col => {
            colour.applyColours(col, scheme, this.editorDecorations);
        });
    }

    onColoursForCompiler(compilerId: number, colours: Record<number, number>, scheme: string): void {
        if (this.id === compilerId) {
            colour.applyColours(colours, scheme, this.editorDecorations);
        }
    }

    getCompilerName(): string {
        return this.compiler ? this.compiler.name : 'No compiler set';
    }

    getLanguageName(): string {
        const lang = options.languages[this.currentLangId ?? ''];

        return lang?.name ?? '?';
    }

    override getDefaultPaneName(): string {
        return '';
    }

    updateCompilerName(): void {
        const compilerName = this.getCompilerName();
        const compilerVersion = this.compiler?.version ?? '';
        const compilerFullVersion = this.compiler?.fullVersion ?? compilerVersion;
        const compilerNotification = this.compiler?.notification ?? '';
        this.shortCompilerName.text(compilerName);
        this.setCompilerVersionPopover(
            {
                version: compilerVersion,
                fullVersion: compilerFullVersion,
            },
            compilerNotification,
            this.compiler?.id,
        );
        this.updateTitle();
    }

    resendResult(): boolean {
        if (this.lastResult) {
            if (this.compiler) {
                this.eventHub.emit(
                    'compileResult',
                    this.id,
                    this.compiler,
                    this.lastResult,
                    this.currentLangId ? languages[this.currentLangId] : undefined,
                );
            }
            return true;
        }
        return false;
    }

    onResendCompilation(id: number): void {
        if (id === this.id) {
            this.resendResult();
        }
    }

    updateDecorations(): void {
        this.prevDecorations = this.editor.deltaDecorations(
            this.prevDecorations,
            _.flatten(Object.values(this.decorations)),
        );
    }

    clearLinkedLines(): void {
        this.decorations.linkedCode = [];
        this.updateDecorations();
    }

    onPanesLinkLine(
        compilerId: number,
        lineNumber: number,
        colBegin: number,
        colEnd: number,
        revealLine: boolean,
        sender: string,
        editorId?: number,
    ): void {
        if (Number(compilerId) === this.id) {
            const lineNums: number[] = [];
            const directlyLinkedLineNums: number[] = [];
            const signalFromAnotherPane = sender !== this.getPaneName();
            this.assembly.forEach((asmLine, i) => {
                if (asmLine.source && asmLine.source.line === lineNumber) {
                    const fileEditorId = this.getEditorIdBySourcefile(asmLine.source);
                    if (fileEditorId && editorId === fileEditorId) {
                        const line = i + 1;
                        lineNums.push(line);
                        const currentCol = asmLine.source.column;
                        if (signalFromAnotherPane && currentCol && colBegin <= currentCol && currentCol <= colEnd) {
                            directlyLinkedLineNums.push(line);
                        }
                    }
                }
            });

            if (revealLine && lineNums[0]) {
                this.pushRevealJump();
                this.hub.activateTabForContainer(this.container);
                this.editor.revealLineInCenter(lineNums[0]);
            }

            const lineClass = sender !== this.getPaneName() ? 'linked-code-decoration-line' : '';
            const linkedLinesDecoration: LinkedCode[] = lineNums.map(line => ({
                range: new monaco.Range(line, 1, line, 1),
                options: {
                    isWholeLine: true,
                    linesDecorationsClassName: 'linked-code-decoration-margin',
                    className: lineClass,
                },
            }));

            const directlyLinkedLinesDecoration: LinkedCode[] = directlyLinkedLineNums.map(line => ({
                range: new monaco.Range(line, 1, line, 1),
                options: {
                    isWholeLine: true,
                    inlineClassName: 'linked-code-decoration-column',
                },
            }));

            this.decorations.linkedCode = linkedLinesDecoration.concat(directlyLinkedLinesDecoration);

            if (!this.settings.indefiniteLineHighlight) {
                if (this.linkedFadeTimeoutId !== null) {
                    clearTimeout(this.linkedFadeTimeoutId);
                }

                this.linkedFadeTimeoutId = setTimeout(() => {
                    this.clearLinkedLines();
                    this.linkedFadeTimeoutId = null;
                }, 5000);
            }
            this.updateDecorations();
        }
    }

    onCompilerSetDecorations(id: number, lineNums: number[], revealLine?: boolean): void {
        if (Number(id) === this.id) {
            if (revealLine && lineNums[0]) {
                this.pushRevealJump();
                this.editor.revealLineInCenter(lineNums[0]);
            }
            this.decorations.linkedCode = lineNums.map(line => {
                return {
                    range: new monaco.Range(line, 1, line, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: 'linked-code-decoration-margin',
                        inlineClassName: 'linked-code-decoration-inline',
                    },
                };
            });
            this.updateDecorations();
        }
    }

    setCompilationOptionsPopover(content: string | null, warnings: string[]): void {
        const infoLine =
            '<div class="compiler-arg-warning info">You can configure icon animations in Settings>Compilation</div>\n';

        // Dispose any existing popover
        const existingPopover = BootstrapUtils.getPopoverInstance(this.prependOptions);
        if (existingPopover) existingPopover.dispose();

        // Create new popover
        BootstrapUtils.initPopover(this.prependOptions, {
            content:
                warnings.map(w => `<div class="compiler-arg-warning">${w}</div>`).join('\n') +
                '\n' +
                (warnings.length > 0 ? infoLine : '') +
                escapeHTML(content || 'No options in use') +
                `\n<div class="compiler-arg-warning-shake-setting"></div>`,
            html: true,
            template:
                '<div class="popover' +
                (content ? ' compiler-options-popover' : '') +
                '" role="tooltip"><div class="arrow"></div>' +
                '<h3 class="popover-header"></h3><div class="popover-body"></div></div>',
        });

        // TODO: Kind of redundant with compiler-service's handleCompilationStatus and overriding what that function
        // does. I hate that the logic is spread out like this. Definitely in need of a refactor.
        if (warnings.length > 0) {
            this.statusIcon
                .removeClass()
                .addClass(
                    'status-icon fa-solid fa-triangle-exclamation compiler-arg-warning-icon' +
                        (this.settings.shakeStatusIconOnWarnings ? ' shake' : ''),
                )
                .css('color', '')
                .attr('aria-label', 'There are warnings about the compiler arguments that have been provided');
        }
    }

    setCompilerVersionPopover(version?: CompilerVersionInfo, notification?: string, compilerId?: string) {
        setCompilerVersionPopoverForPane(this, version, notification, compilerId);
    }

    onRequestCompilation(editorId: number | boolean, treeId: number | boolean): void {
        if (editorId === this.sourceEditorId || (treeId && treeId === this.sourceTreeId)) {
            this.compile();
        }
    }

    override onSettingsChange(newSettings: SiteSettings): void {
        const before = this.settings;
        this.settings = {...newSettings};
        if (!before.hoverShowSource && this.settings.hoverShowSource) {
            this.onCompilerSetDecorations(this.id, []);
        }
        this.editor.updateOptions({
            contextmenu: this.settings.useCustomContextMenu,
            minimap: {
                enabled: this.settings.showMinimap && !options.embedded,
            },
            fontFamily: this.settings.editorsFFont,
            codeLensFontFamily: this.settings.editorsFFont,
            fontLigatures: this.settings.editorsFLigatures,
        });
    }

    public static async getAsmInfo(
        opcode: string,
        instructionSet: InstructionSet,
    ): Promise<AssemblyInstructionInfo | undefined> {
        const cacheName = `asm/${instructionSet}/${opcode}`;
        const cached = OpcodeCache.get(cacheName);
        if (cached) {
            if (cached.found) return cached.data as AssemblyInstructionInfo;
            throw new Error(cached.data as string);
        }

        const response = await getAssemblyDocumentation({opcode, instructionSet});
        const body = await response.json();
        if (response.status === 200) {
            OpcodeCache.set(cacheName, {found: true, data: body});
            return body;
        }
        const error = (body as any).error;
        OpcodeCache.set(cacheName, {found: false, data: error});
        throw new Error(error);
    }

    override onDidChangeCursorSelection(e) {
        if (this.awaitingInitialResults) {
            this.selection = e.selection;
            this.updateState();
        }
    }

    onMouseUp(e: any): void {
        if (e === null || e.target === null || e.target.position === null) return;

        if (e.event.ctrlKey && e.event.leftButton) {
            this.jumpToLabel(e.target.position);
        }
    }

    async onMouseMove(e: any) {
        if (e === null || e.target === null || e.target.position === null) return;
        const hoverShowSource = this.settings.hoverShowSource === true;
        const hoverAsm = this.assembly[e.target.position.lineNumber - 1];

        if (hoverShowSource && hoverAsm) {
            this.clearLinkedLines();
            // We check that we actually have something to show at this point!
            let sourceLine = -1;
            let sourceColBegin = -1;
            let sourceColEnd = -1;
            if (hoverAsm.source) {
                sourceLine = hoverAsm.source.line;
                if (hoverAsm.source.column) {
                    sourceColBegin = hoverAsm.source.column;
                    sourceColEnd = sourceColBegin;
                }

                const editorId = this.getEditorIdBySourcefile(hoverAsm.source);
                if (editorId) {
                    this.eventHub.emit('editorLinkLine', editorId, sourceLine, sourceColBegin, sourceColEnd, false);

                    this.eventHub.emit(
                        'panesLinkLine',
                        this.id,
                        sourceLine,
                        sourceColBegin,
                        sourceColEnd,
                        false,
                        this.getPaneName(),
                        editorId,
                    );
                }
            }
        }
        const currentWord = this.editor.getModel()?.getWordAtPosition(e.target.position);
        if (currentWord?.word) {
            let word = currentWord.word;
            let startColumn = currentWord.startColumn;
            // Avoid throwing an exception if somehow (How?) we have a non-existent lineNumber.
            // c.f. https://sentry.io/matt-godbolt/compiler-explorer/issues/285270358/
            if (e.target.position.lineNumber <= (this.editor.getModel()?.getLineCount() ?? 0)) {
                // Hacky workaround to check for negative numbers.
                // c.f. https://github.com/compiler-explorer/compiler-explorer/issues/434
                const lineContent = this.editor.getModel()?.getLineContent(e.target.position.lineNumber);
                if (lineContent && lineContent[currentWord.startColumn - 2] === '-') {
                    word = '-' + word;
                    startColumn -= 1;
                }
            }
            const range = new monaco.Range(
                e.target.position.lineNumber,
                Math.max(startColumn, 1),
                e.target.position.lineNumber,
                currentWord.endColumn,
            );
            const lang = this.compiler?.lang;
            const language = lang === undefined ? undefined : languages[lang];
            const numericToolTip = utils.getNumericToolTip(word, language?.digitSeparator);
            if (numericToolTip) {
                this.decorations.numericToolTip = [
                    {
                        range: range,
                        options: {
                            isWholeLine: false,
                            hoverMessage: [
                                {
                                    // We use double `` as numericToolTip may include a single ` character.
                                    value: '``' + numericToolTip + '``',
                                },
                            ],
                        },
                    },
                ];
                this.updateDecorations();
            }
            const hoverShowAsmDoc = this.settings.hoverShowAsmDoc;
            if (
                hoverShowAsmDoc &&
                this.compiler &&
                this.compiler.supportsAsmDocs &&
                this.isWordAsmKeyword(e.target.position.lineNumber, currentWord)
            ) {
                try {
                    const response = await Compiler.getAsmInfo(
                        currentWord.word,
                        unwrap(this.recentInstructionSet || this.compiler.instructionSet),
                    );
                    if (!response) return;
                    this.decorations.asmToolTip = [
                        {
                            range: range,
                            options: {
                                isWholeLine: false,
                                hoverMessage: [
                                    {
                                        value: response.tooltip + '\n\nMore information available in the context menu.',
                                        isTrusted: true,
                                    },
                                ],
                            },
                        },
                    ];
                    this.updateDecorations();
                } catch {
                    // ignore errors fetching tooltips
                }
            }
        }
    }

    getLineTokens(line: number): monaco.Token[] {
        const model = this.editor.getModel();
        if (!model || line > model.getLineCount()) return [];
        const flavour = model.getLanguageId();
        const tokens = monaco.editor.tokenize(model.getLineContent(line), flavour);
        return tokens.length > 0 ? tokens[0] : [];
    }

    isWordAsmKeyword(lineNumber: number, word: monaco.editor.IWordAtPosition): boolean {
        return this.getLineTokens(lineNumber).some(t => {
            return (
                t.offset + 1 === word.startColumn &&
                // if this list of monaco token-types ever gets longer, it's best to refactor this
                ['keyword.asm', 'keyword.llvm-ir', 'operators.llvm-ir'].includes(t.type)
            );
        });
    }

    async onAsmToolTip(ed: monaco.editor.ICodeEditor) {
        const pos = ed.getPosition();
        if (!pos || !ed.getModel()) return;
        const word = ed.getModel()?.getWordAtPosition(pos);
        if (!word || !word.word) return;
        const opcode = word.word.toUpperCase();

        function newGitHubIssueUrl(): string {
            return (
                'https://github.com/compiler-explorer/compiler-explorer/issues/new?title=' +
                encodeURIComponent('[BUG] Problem with ' + opcode + ' opcode')
            );
        }

        function appendInfo(url: string): string {
            return (
                '<br><br>For more information, visit <a href="' +
                url +
                '" target="_blank" rel="noopener noreferrer">the ' +
                opcode +
                ' documentation <sup><small class="fas fa-external-link-alt opens-new-window"' +
                ' title="Opens in a new window"></small></sup></a>.' +
                '<br>If the documentation for this opcode is wrong or broken in some way, ' +
                'please feel free to <a href="' +
                newGitHubIssueUrl() +
                '" target="_blank" rel="noopener noreferrer">' +
                'open an issue on GitHub <sup><small class="fas fa-external-link-alt opens-new-window" ' +
                'title="Opens in a new window"></small></sup></a>.'
            );
        }

        try {
            if (this.compiler?.supportsAsmDocs) {
                const asmHelp = await Compiler.getAsmInfo(
                    word.word,
                    unwrap(this.recentInstructionSet || this.compiler.instructionSet),
                );
                if (asmHelp) {
                    this.alertSystem.alert(opcode + ' help', asmHelp.html + appendInfo(asmHelp.url), {
                        onClose: () => {
                            ed.focus();
                            ed.setPosition(pos);
                        },
                    });
                } else {
                    this.alertSystem.notify('This token was not found in the documentation. Sorry!', {
                        group: 'notokenindocs',
                        alertClass: 'notification-error',
                        dismissTime: 5000,
                    });
                }
            }
        } catch (error) {
            this.alertSystem.notify('There was an error fetching the documentation for this opcode (' + error + ').', {
                group: 'notokenindocs',
                alertClass: 'notification-error',
                dismissTime: 5000,
            });
        }
    }

    handleCompilationStatus(status: CompilationStatus): void {
        CompilerService.handleCompilationStatus(this.statusLabel, this.statusIcon, status);
    }

    onLanguageChange(editorId: number | boolean, newLangId: LanguageKey, treeId?: number | boolean): void {
        if (
            (this.sourceEditorId && this.sourceEditorId === editorId) ||
            (this.sourceTreeId && this.sourceTreeId === treeId)
        ) {
            const oldLangId = this.currentLangId ?? '';
            this.currentLangId = newLangId;
            // Store the current selected stuff to come back to it later in the same session (Not state stored!)
            this.infoByLang[oldLangId] = {
                compiler: this.compiler?.id ? this.compiler.id : options.defaultCompiler[oldLangId as LanguageKey],
                options: this.options,
            };

            const info = this.infoByLang[this.currentLangId] || {};
            this.deferCompiles = true;
            this.initLangAndCompiler({lang: newLangId, compiler: info.compiler});
            this.updateCompilersSelector(info);
            this.updateState();
            this.updateCompilerUI();
            this.setAssembly({asm: this.fakeAsm('')});
            // this is a workaround to delay compilation further until the Editor sends a compile request
            this.needsCompile = false;

            this.undefer();
            this.sendCompiler();
        }
    }

    override updateState() {
        const state = this.getCurrentState();
        this.container.setState(state);
        this.compilerShared.updateState(state);
    }

    override getPaneTag() {
        const editorId = this.sourceEditorId;
        const treeId = this.sourceTreeId;
        const compilerName = this.getCompilerName();

        if (editorId) {
            return `${compilerName} (Editor #${editorId})`;
        }
        return `${compilerName} (Tree #${treeId})`;
    }

    override getExtraPrintData() {
        return `<p>Flags: <code>${escapeHTML(unwrapString(this.optionsField.val()))}</code></p>`;
    }

    override resize() {
        _.defer(() => {
            const topBarHeight = utils.updateAndCalcTopBarHeight(this.domRoot, this.topBar, this.hideable);
            const bottomBarHeight = this.bottomBar.outerHeight(true) ?? 0;
            this.editor.layout({
                width: unwrap(this.domRoot.width()),
                height: unwrap(this.domRoot.height()) - topBarHeight - bottomBarHeight,
            });
        });
    }
    updateCompilersSelector(info: {options?: string}) {
        if (this.compilerPicker instanceof CompilerPicker)
            this.compilerPicker.update(this.currentLangId ?? '', this.compiler?.id ?? '');
        this.options = info.options || '';
        this.optionsField.val(this.options);
    }
}

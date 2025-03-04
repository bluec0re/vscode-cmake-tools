/**
 * Root of the extension
 */
import {CMakeCache} from '@cmt/cache';
import {CMakeExecutable, getCMakeExecutableInformation} from '@cmt/cmake/cmake-executable';
import {CompilationDatabase} from '@cmt/compdb';
import * as debugger_mod from '@cmt/debugger';
import diagCollections from '@cmt/diagnostics/collections';
import * as shlex from '@cmt/shlex';
import {StateManager} from '@cmt/state';
import {Strand} from '@cmt/strand';
import {ProgressHandle, versionToString, lightNormalizePath, Version, versionLess} from '@cmt/util';
import {DirectoryContext} from '@cmt/workspace';
import * as path from 'path';
import * as vscode from 'vscode';

import * as api from './api';
import {ExecutionOptions, ExecutionResult} from './api';
import * as codemodel_api from '@cmt/drivers/codemodel-driver-interface';
import {BadHomeDirectoryError} from '@cmt/drivers/cms-client';
import {CMakeServerClientDriver, NoGeneratorError} from '@cmt/drivers/cms-driver';
import {CTestDriver} from './ctest';
import {BasicTestResults} from './ctest';
import {CMakeBuildConsumer} from './diagnostics/build';
import {CMakeOutputConsumer} from './diagnostics/cmake';
import {populateCollection} from './diagnostics/util';
import {CMakeDriver, CMakePreconditionProblems} from '@cmt/drivers/driver';
import {expandString, ExpansionOptions} from './expand';
import {CMakeGenerator, Kit} from './kit';
import {LegacyCMakeDriver} from '@cmt/drivers/legacy-driver';
import * as logging from './logging';
import {fs} from './pr';
import {buildCmdStr} from './proc';
import {Property} from './prop';
import rollbar from './rollbar';
import * as telemetry from './telemetry';
import {setContextValue} from './util';
import {VariantManager} from './variant';
import {CMakeFileApiDriver} from '@cmt/drivers/cmfileapi-driver';
import * as nls from 'vscode-nls';
import paths from './paths';
import {CMakeToolsFolder} from './folders';
import {ConfigurationWebview} from './cache-view';
import {updateFullFeatureSetForFolder, registerTaskProvider, enableFullFeatureSet, isActiveFolder} from './extension';
import { ConfigurationReader } from './config';
import * as preset from '@cmt/preset';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const open = require('open') as ((url: string, appName?: string, callback?: Function) => void);

const log = logging.createLogger('main');
const BUILD_LOGGER = logging.createLogger('build');
const CMAKE_LOGGER = logging.createLogger('cmake');

export enum ConfigureType {
  Normal,
  Clean,
  Cache,
}

export enum ConfigureTrigger {
  api = "api",
  runTests = "runTests",
  badHomeDir = "badHomeDir",
  configureOnOpen = "configureOnOpen",
  quickStart = "quickStart",
  setVariant = "setVariant",
  cmakeListsChange = "cmakeListsChange",
  sourceDirectoryChange = "sourceDirectoryChange",
  buttonNewKitsDefinition = "buttonNewKitsDefinition",
  compilation = "compilation",
  launch = "launch",
  commandEditCacheUI = "commandEditCacheUI",
  commandConfigure = "commandConfigure",
  commandCleanConfigure = "commandCleanConfigure",
  commandConfigureAll = "commandConfigureAll",
  commandCleanConfigureAll = "commandCleanConfigureAll",
}

/**
 * Class implementing the extension. It's all here!
 *
 * The class internally uses a two-phase initialization, since proper startup
 * requires asynchrony. To ensure proper initialization. The class must be
 * created via the `create` static method. This will run the two phases
 * internally and return a promise to the new instance. This ensures that the
 * class invariants are maintained at all times.
 *
 * Some fields also require two-phase init. Their first phase is in the first
 * phase of the CMakeTools init, ie. the constructor.
 *
 * The second phases of fields will be called by the second phase of the parent
 * class. See the `_init` private method for this initialization.
 */
export class CMakeTools implements vscode.Disposable, api.CMakeToolsAPI {
  /**
   * Construct a new instance. The instance isn't ready, and must be initalized.
   * @param extensionContext The extension context
   *
   * This is private. You must call `create` to get an instance.
   */
  private constructor(readonly extensionContext: vscode.ExtensionContext, readonly workspaceContext: DirectoryContext) {
    // Handle the active kit changing. We want to do some updates and teardown
    log.debug(localize('constructing.cmaketools', 'Constructing new CMakeTools instance'));
  }

  /**
   * The workspace folder associated with this CMakeTools instance
   */
  get folder(): vscode.WorkspaceFolder { return this.workspaceContext.folder; }

  /**
   * The name of the workspace folder for this CMakeTools instance
   */
  get folderName(): string { return this.folder.name; }

  /**
   * Whether we use presets
   */
  private _useCMakePresets = false; // The default value doesn't matter, value is set when folder is loaded
  get useCMakePresets(): boolean { return this._useCMakePresets; }
  async setUseCMakePresets(useCMakePresets: boolean) {
    const oldValue = this._useCMakePresets;
    if (oldValue !== useCMakePresets) {
      this._useCMakePresets = useCMakePresets;
      const drv = await this._cmakeDriver;
      if (drv) {
        log.debug(localize('disposing.driver', 'Disposing CMake driver'));
        await drv.asyncDispose();
        this._cmakeDriver = Promise.resolve(null);
      }
    }
  }

  // Events that effect the user-interface
  /**
   * The status of this backend
   */
  get statusMessage() { return this._statusMessage.value; }
  get onStatusMessageChanged() { return this._statusMessage.changeEvent; }
  private readonly _statusMessage = new Property<string>(localize('initializing', 'Initializing'));

  /**
   * Minimum cmake version supported. Currently only used for presets
   */
  get minCMakeVersion() { return this._minCMakeVersion; }
  set minCMakeVersion(version: Version | undefined) { this._minCMakeVersion = version; }
  private _minCMakeVersion?: Version;


  /**
   * Currently selected configure preset
   */
  get configurePreset() { return this._configurePreset.value; }
  get onActiveConfigurePresetChanged() { return this._configurePreset.changeEvent; }
  private readonly _configurePreset = new Property<preset.ConfigurePreset | null>(null);
  private resetPresets() {
    this.workspaceContext.state.configurePresetName = null;
    this.workspaceContext.state.buildPresetName = null;
    this.workspaceContext.state.testPresetName = null;
    this._configurePreset.set(null);
    this._buildPreset.set(null);
    this._testPreset.set(null);
  }
  async setConfigurePreset(configurePreset: string | null) {
    if (configurePreset) {
      log.debug(localize('resolving.config.preset', 'Resolving the selected configure preset'));
      const expandedConfigurePreset = await preset.expandConfigurePreset(this.folder.uri.fsPath,
                                                                         configurePreset,
                                                                         lightNormalizePath(this.folder.uri.fsPath || '.'),
                                                                         await this.sourceDir,
                                                                         true);
      this._configurePreset.set(expandedConfigurePreset);
      if (!expandedConfigurePreset) {
        log.error(localize('failed.resolve.config.preset', 'Failed to resolve configure preset: {0}', configurePreset));
        this.resetPresets();
        return;
      }
      if (!expandedConfigurePreset.binaryDir) {
        log.error(localize('binaryDir.not.set.config.preset', '"binaryDir" is not set in configure preset: {0}', configurePreset));
        // Set to null so if we won't get wrong selection option when selectbuild/testPreset before a configure preset is selected.
        this.resetPresets();
        return;
      }
      if (!expandedConfigurePreset.generator) {
        log.error(localize('generator.not.set.config.preset', '"generator" is not set in configure preset: {0}', configurePreset));
        // Set to null so if we won't get wrong selection option when selectbuild/testPreset before a configure preset is selected.
        this.resetPresets();
        return;
      }
      log.debug(localize('loading.new.config.preset', 'Loading new configure preset into CMake driver'));
      const drv = await this._cmakeDriver;  // Use only an existing driver, do not create one
      if (drv) {
        try {
          this._statusMessage.set(localize('reloading.status', 'Reloading...'));
          await drv.setConfigurePreset(expandedConfigurePreset);
          this.workspaceContext.state.configurePresetName = configurePreset;
          this._statusMessage.set(localize('ready.status', 'Ready'));
        } catch (error) {
          vscode.window.showErrorMessage(localize('unable.to.set.config.preset', 'Unable to set configure preset "{0}".', error));
          this._statusMessage.set(localize('error.on.switch.config.preset', 'Error on switch of configure preset ({0})', error.message));
          this._cmakeDriver = Promise.resolve(null);
          this.resetPresets();
        }
      } else {
        // Remember the selected configure preset for the next session.
        this.workspaceContext.state.configurePresetName = configurePreset;
      }
    } else {
      this.resetPresets();
    }
  }

  /**
   * Currently selected build preset
   */
  get buildPreset() { return this._buildPreset.value; }
  get onActiveBuildPresetChanged() { return this._buildPreset.changeEvent; }
  private readonly _buildPreset = new Property<preset.BuildPreset | null>(null);
  async setBuildPreset(buildPreset: string | null) {
    if (buildPreset) {
      log.debug(localize('resolving.build.preset', 'Resolving the selected build preset'));
      const expandedBuildPreset = await preset.expandBuildPreset(this.folder.uri.fsPath,
                                                                 buildPreset,
                                                                 lightNormalizePath(this.folder.uri.fsPath || '.'),
                                                                 await this.sourceDir,
                                                                 true,
                                                                 this.configurePreset?.name);
      this._buildPreset.set(expandedBuildPreset);
      if (!expandedBuildPreset) {
        log.error(localize('failed.resolve.build.preset', 'Failed to resolve build preset: {0}', buildPreset));
        this._buildPreset.set(null);
        return;
      }
      if (!expandedBuildPreset.configurePreset) {
        log.error(localize('configurePreset.not.set.build.preset', '"configurePreset" is not set in build preset: {0}', buildPreset));
        this._buildPreset.set(null);
        return;
      }
      log.debug(localize('loading.new.build.preset', 'Loading new build preset into CMake driver'));
      const drv = await this._cmakeDriver;  // Use only an existing driver, do not create one
      if (drv) {
        try {
          this._statusMessage.set(localize('reloading.status', 'Reloading...'));
          await drv.setBuildPreset(expandedBuildPreset);
          await this.reRegisterTaskProviderforNewTarget(drv, undefined);
          this.workspaceContext.state.buildPresetName = buildPreset;
          this._statusMessage.set(localize('ready.status', 'Ready'));
        } catch (error) {
          vscode.window.showErrorMessage(localize('unable.to.set.build.preset', 'Unable to set build preset "{0}".', error));
          this._statusMessage.set(localize('error.on.switch.build.preset', 'Error on switch of build preset ({0})', error.message));
          this._cmakeDriver = Promise.resolve(null);
          this._buildPreset.set(null);
        }
      } else {
        // Remember the selected build preset for the next session.
        this.workspaceContext.state.buildPresetName = buildPreset;
      }
    } else {
      this._buildPreset.set(null);
      this.workspaceContext.state.buildPresetName = buildPreset;
    }
  }

  /**
   * Currently selected test preset
   */
  get testPreset() { return this._testPreset.value; }
  get onActiveTestPresetChanged() { return this._testPreset.changeEvent; }
  private readonly _testPreset = new Property<preset.TestPreset | null>(null);
  async setTestPreset(testPreset: string | null) {
    if (testPreset) {
      log.debug(localize('resolving.test.preset', 'Resolving the selected test preset'));
      const expandedTestPreset = await preset.expandTestPreset(this.folder.uri.fsPath,
                                                               testPreset,
                                                               lightNormalizePath(this.folder.uri.fsPath || '.'),
                                                               await this.sourceDir,
                                                               true,
                                                               this.configurePreset?.name);
      this._testPreset.set(expandedTestPreset);
      if (!expandedTestPreset) {
        log.error(localize('failed.resolve.test.preset', 'Failed to resolve test preset: {0}', testPreset));
        this._testPreset.set(null);
        return;
      }
      if (!expandedTestPreset.configurePreset) {
        log.error(localize('configurePreset.not.set.test.preset', '"configurePreset" is not set in test preset: {0}', testPreset));
        this._testPreset.set(null);
        return;
      }
      log.debug(localize('loading.new.test.preset', 'Loading new test preset into CMake driver'));
      const drv = await this._cmakeDriver;  // Use only an existing driver, do not create one
      if (drv) {
        try {
          this._statusMessage.set(localize('reloading.status', 'Reloading...'));
          await drv.setTestPreset(expandedTestPreset);
          this.workspaceContext.state.testPresetName = testPreset;
          this._statusMessage.set(localize('ready.status', 'Ready'));
        } catch (error) {
          vscode.window.showErrorMessage(localize('unable.to.set.test.preset', 'Unable to set test preset "{0}".', error));
          this._statusMessage.set(localize('error.on.switch.test.preset', 'Error on switch of test preset ({0})', error.message));
          this._cmakeDriver = Promise.resolve(null);
          this._testPreset.set(null);
        }
      } else {
        // Remember the selected test preset for the next session.
        this.workspaceContext.state.testPresetName = testPreset;
      }
    } else {
      this._testPreset.set(null);
      this.workspaceContext.state.testPresetName = testPreset;
    }
  }

  /**
   * The current target to build.
   */
  get targetName() { return this._targetName.value; }
  get onTargetNameChanged() { return this._targetName.changeEvent; }
  private readonly _targetName = new Property<string>('all');

  /**
   * The current variant
   */
  get activeVariant() { return this._activeVariant.value; }
  get onActiveVariantChanged() { return this._activeVariant.changeEvent; }
  private readonly _activeVariant = new Property<string>('Unconfigured');

  /**
   * The "launch target" (the target that will be run by debugging)
   */
  get launchTargetName() { return this._launchTargetName.value; }
  get onLaunchTargetNameChanged() { return this._launchTargetName.changeEvent; }
  private readonly _launchTargetName = new Property<string|null>(null);

  /**
   * Whether CTest is enabled
   */
  get ctestEnabled() { return this._ctestEnabled.value; }
  get onCTestEnabledChanged() { return this._ctestEnabled.changeEvent; }
  private readonly _ctestEnabled = new Property<boolean>(false);

  /**
   * The current CTest results
   */
  get testResults() { return this._testResults.value; }
  get onTestResultsChanged() { return this._testResults.changeEvent; }
  private readonly _testResults = new Property<BasicTestResults|null>(null);

  /**
   * Whether the backend is busy running some task
   */
  get isBusy() { return this._isBusy.value; }
  get onIsBusyChanged() { return this._isBusy.changeEvent; }
  private readonly _isBusy = new Property<boolean>(false);

  /**
   * Event fired when the code model from CMake is updated
   */
  get codeModel() { return this._codeModel.value; }
  get onCodeModelChanged() { return this._codeModel.changeEvent; }
  private readonly _codeModel = new Property<codemodel_api.CodeModelContent|null>(null);
  private _codeModelDriverSub: vscode.Disposable|null = null;

  private readonly _communicationModeSub = this.workspaceContext.config.onChange('cmakeCommunicationMode', () => {
    log.info(localize('communication.changed.restart.driver', "Restarting the CMake driver after a communication mode change."));
    return this._reloadCMakeDriver();
  });

  private readonly _generatorSub = this.workspaceContext.config.onChange('generator', () => {
    log.info(localize('generator.changed.restart.driver', "Restarting the CMake driver after a generator change."));
    return this._reloadCMakeDriver();
  });

  private readonly _preferredGeneratorsSub = this.workspaceContext.config.onChange('preferredGenerators', () => {
    log.info(localize('preferredGenerator.changed.restart.driver', "Restarting the CMake driver after a preferredGenerators change."));
    return this._reloadCMakeDriver();
  });

  /**
   * The variant manager keeps track of build variants. Has two-phase init.
   */
  private readonly _variantManager = new VariantManager(this.folder, this.workspaceContext.state, this.workspaceContext.config);

  /**
   * A strand to serialize operations with the CMake driver
   */
  private readonly _driverStrand = new Strand();

  /**
   * The object in charge of talking to CMake. It starts empty (null) because
   * we don't know what driver to use at the current time. The driver also has
   * two-phase init and a private constructor. The driver may be replaced at
   * any time by the user making changes to the workspace configuration.
   */
  private _cmakeDriver: Promise<CMakeDriver|null> = Promise.resolve(null);

  /**
   * This object manages the CMake Cache Editor GUI
   */
  private _cacheEditorWebview: ConfigurationWebview | undefined;

  /**
   * Event fired just as CMakeTools is about to be disposed
   */
  get onDispose() { return this._disposeEmitter.event; }
  private readonly _disposeEmitter = new vscode.EventEmitter<void>();

  /**
   * Dispose the instance
   */
  dispose() {
    log.debug(localize('disposing.extension', 'Disposing CMakeTools extension'));
    this._disposeEmitter.fire();
    this._termCloseSub.dispose();
    if (this._launchTerminal) {
      this._launchTerminal.dispose();
    }
    for (const sub of [this._generatorSub, this._preferredGeneratorsSub, this._communicationModeSub]) {
      sub.dispose();
    }
    rollbar.invokeAsync(localize('extension.dispose', 'Extension dispose'), () => this.asyncDispose());
  }

  /**
   * Dispose of the extension asynchronously.
   */
  async asyncDispose() {
    diagCollections.reset();
    if (this._cmakeDriver) {
      const drv = await this._cmakeDriver;
      if (drv) {
        await drv.asyncDispose();
      }
    }
    for (const disp of [this._statusMessage,
                        this._targetName,
                        this._activeVariant,
                        this._ctestEnabled,
                        this._testResults,
                        this._isBusy,
                        this._variantManager,
                        this._ctestController,
    ]) {
      disp.dispose();
    }
  }

  private getPreferredGenerators(): CMakeGenerator[] {
    // User can override generator with a setting
    const user_generator = this.workspaceContext.config.generator;
    if (user_generator) {
      log.debug(localize('using.user.generator', 'Using generator from user configuration: {0}', user_generator));
      return [{
        name: user_generator,
        platform: this.workspaceContext.config.platform || undefined,
        toolset: this.workspaceContext.config.toolset || undefined,
      }];
    }

    const user_preferred = this.workspaceContext.config.preferredGenerators.map(g => ({name: g}));
    return user_preferred;
  }

  /**
   * Execute pre-configure/build tasks to check if we are ready to run a full
   * configure. This should be called by a derived driver before any
   * configuration tasks are run
   */
  private async cmakePreConditionProblemHandler(e: CMakePreconditionProblems, config?: ConfigurationReader): Promise<void> {
    switch (e) {
    case CMakePreconditionProblems.ConfigureIsAlreadyRunning:
      vscode.window.showErrorMessage(localize('configuration.already.in.progress', 'Configuration is already in progress.'));
      break;
    case CMakePreconditionProblems.BuildIsAlreadyRunning:
      vscode.window.showErrorMessage(localize('task.already.running', 'A CMake task is already running. Stop it before trying to run a new CMake task.'));
      break;
    case CMakePreconditionProblems.NoSourceDirectoryFound:
      vscode.window.showErrorMessage(localize('no.source.directory.found', 'You do not have a source directory open'));
      break;
    case CMakePreconditionProblems.MissingCMakeListsFile:
      if (!this.workspaceContext.state.ignoreCMakeListsMissing) {
        const quickStart = localize('quickstart.cmake.project', 'Create');
        const changeSetting = localize('edit.setting', 'Locate');
        const ignoreCMakeListsMissing = localize('ignore.activation', "Don't show again");
        const result = await vscode.window.showErrorMessage(
            localize('missing.cmakelists', 'CMakeLists.txt was not found in the root of the folder \'{0}\'. How would you like to proceed?', this.folderName),
            quickStart, changeSetting, ignoreCMakeListsMissing);
        if (result === quickStart) {
          // Return here, since the updateFolderFullFeature set below (after the "switch")
          // will set unnecessarily a partial feature set view for this folder
          // if quickStart doesn't finish early enough.
          // quickStart will update correctly the full/partial view state at the end.
          return vscode.commands.executeCommand('cmake.quickStart');
        } else if (result === changeSetting) {
          // Open the search file dialog from the path set by cmake.sourceDirectory or from the current workspace folder
          // if the setting is not defined.
          const openOpts: vscode.OpenDialogOptions = {
            canSelectMany: false,
            defaultUri: vscode.Uri.file(this.folder.uri.fsPath),
            filters: {"CMake files": ["txt"], "All files": ["*"]},
            openLabel: "Load",
          };
          const cmakeListsFile = await vscode.window.showOpenDialog(openOpts);
          if (cmakeListsFile) {
            const fullPathDir: string = path.parse(cmakeListsFile[0].fsPath).dir;
            const relPathDir: string = lightNormalizePath(path.relative(this.folder.uri.fsPath, fullPathDir));
            const joinedPath = "${workspaceFolder}/".concat(relPathDir);
            vscode.workspace.getConfiguration('cmake', this.folder.uri).update("sourceDirectory", joinedPath);

            if (config) {
              // Updating sourceDirectory here, at the beginning of the configure process,
              // doesn't need to fire the settings change event (which would trigger unnecessarily
              // another immediate configure, which will be blocked anyway).
              config.updatePartial({sourceDirectory: joinedPath}, false);

              // Since the source directory is set via a file open dialog tuned to CMakeLists.txt,
              // we know that it exists and we don't need any other additional checks on its value,
              // so simply enable full feature set.
              enableFullFeatureSet(true);
            }
          }
        } else if (result === ignoreCMakeListsMissing) {
          // The user ignores the missing CMakeLists.txt file --> limit the CMake Tools extension functionality
          // (hide commands and status bar) and record this choice so that this popup doesn't trigger next time.
          // The switch back to full functionality can be done later by changes to the cmake.sourceDirectory setting
          // or to the CMakeLists.txt file, a successful configure or a configure failing with anything but CMakePreconditionProblems.MissingCMakeListsFile.
          // After that switch (back to a full activation), another occurrence of missing CMakeLists.txt
          // would trigger this popup again.
          this.workspaceContext.state.ignoreCMakeListsMissing = true;
        }
      }

      break;
    }

    // This CMT folder can go through various changes while executing this function
    // that could be relevant to the partial/full feature set view.
    // This is a good place for an update.
    return updateFullFeatureSetForFolder(this.folder);
  }

  /**
   * Start up a new CMake driver and return it. This is so that the initialization
   * of the driver is atomic to those using it
   */
  private async _startNewCMakeDriver(cmake: CMakeExecutable): Promise<CMakeDriver> {
    log.debug(localize('starting.cmake.driver', 'Starting CMake driver'));
    if (!cmake.isPresent) {
      throw new Error(localize('bad.cmake.executable', 'Bad CMake executable "{0}".', cmake.path));
    }

    const workspace = this.folder.uri.fsPath;
    let drv: CMakeDriver;
    const preferredGenerators = this.getPreferredGenerators();
    const preConditionHandler = async (e: CMakePreconditionProblems, config?: ConfigurationReader) => this.cmakePreConditionProblemHandler(e, config);
    let communicationMode = this.workspaceContext.config.cmakeCommunicationMode.toLowerCase();
    const fileApi = 'fileapi';
    const serverApi = 'serverapi';
    const legacy = 'legacy';

    if (communicationMode !== fileApi && communicationMode !== serverApi && communicationMode !== legacy) {
      if (cmake.isFileApiModeSupported) {
        communicationMode = fileApi;
      } else if (cmake.isServerModeSupported) {
        communicationMode = serverApi;
      } else {
        communicationMode = legacy;
      }
    } else if (communicationMode === fileApi) {
      if (!cmake.isFileApiModeSupported) {
        if (cmake.isServerModeSupported) {
          communicationMode = serverApi;
          log.warning(
            localize('switch.to.serverapi',
              'CMake file-api communication mode is not supported in versions earlier than {0}. Switching to CMake server communication mode.',
              versionToString(cmake.minimalFileApiModeVersion)));
        } else {
          communicationMode = legacy;
        }
      }
    }

    if (communicationMode !== fileApi && communicationMode !== serverApi) {
      log.warning(
        localize('please.upgrade.cmake',
          'For the best experience, CMake server or file-api support is required. Please upgrade CMake to {0} or newer.',
          versionToString(cmake.minimalServerModeVersion)));
    }

    try {
      if (communicationMode === serverApi) {
        this._statusMessage.set(localize('starting.cmake.driver.status', 'Starting CMake Server...'));
      }
      switch (communicationMode) {
        case fileApi:
          drv = await CMakeFileApiDriver.create(cmake, this.workspaceContext.config,
                                                this.useCMakePresets,
                                                this.activeKit,
                                                this.configurePreset,
                                                this.buildPreset,
                                                this.testPreset,
                                                workspace,
                                                preConditionHandler,
                                                preferredGenerators);
          break;
        case serverApi:
          drv = await CMakeServerClientDriver.create(cmake,
                                                     this.workspaceContext.config,
                                                     this.useCMakePresets,
                                                     this.activeKit,
                                                     this.configurePreset,
                                                     this.buildPreset,
                                                     this.testPreset,
                                                     workspace,
                                                     preConditionHandler,
                                                     preferredGenerators);
          break;
        default:
          drv = await LegacyCMakeDriver.create(cmake,
                                               this.workspaceContext.config,
                                               this.useCMakePresets,
                                               this.activeKit,
                                               this.configurePreset,
                                               this.buildPreset,
                                               this.testPreset,
                                               workspace,
                                               preConditionHandler,
                                               preferredGenerators);
        }
    } finally { this._statusMessage.set(localize('ready.status', 'Ready')); }

    await drv.setVariant(this._variantManager.activeVariantOptions, this._variantManager.activeKeywordSetting);
    this._targetName.set(this.defaultBuildTarget || drv.allTargetName);
    await this._ctestController.reloadTests(drv);

    // Make sure to re-register the task provider when a new driver is created
    await registerTaskProvider(await this.tasksBuildCommandDrv(drv));

    // All set up. Fulfill the driver promise.
    return drv;
  }

  /**
   * Event fired after CMake configure runs
   */
  get onReconfigured() { return this._onReconfiguredEmitter.event; }
  private readonly _onReconfiguredEmitter = new vscode.EventEmitter<void>();

  private readonly _onTargetChangedEmitter = new vscode.EventEmitter<void>();
  get onTargetChanged() { return this._onTargetChangedEmitter.event; }

  async executeCMakeCommand(args: string[], options?: ExecutionOptions): Promise<ExecutionResult> {
    const drv = await this.getCMakeDriverInstance();
    if (drv) {
      return drv.executeCommand(drv.cmake.path, args, undefined, options).result;
    } else {
      throw new Error(localize('unable.to.execute.cmake.command', 'Unable to execute cmake command, there is no valid cmake driver instance.'));
    }
  }

  async execute(program: string, args: string[], options?: ExecutionOptions): Promise<ExecutionResult> {
    const drv = await this.getCMakeDriverInstance();
    if (drv) {
      return drv.executeCommand(program, args, undefined, options).result;
    } else {
      throw new Error(localize('unable.to.execute.program', 'Unable to execute program, there is no valid cmake driver instance.'));
    }
  }

  /**
   * Reload/restarts the CMake Driver
   */
  private async _reloadCMakeDriver() {
    const drv = await this._cmakeDriver;
    if (drv) {
      log.debug(localize('reloading.driver', 'Reloading CMake driver'));
      await drv.asyncDispose();
      return this._cmakeDriver = this._startNewCMakeDriver(await this.getCMakeExecutable());
    }
  }
  /**
   * Second phase of two-phase init. Called by `create`.
   */
  private async _init() {
    log.debug(localize('second.phase.init', 'Starting CMakeTools second-phase init'));
    // Start up the variant manager
    await this._variantManager.initialize();
    // Set the status bar message
    this._activeVariant.set(this._variantManager.activeVariantOptions.short);
    // Restore the debug target
    this._launchTargetName.set(this.workspaceContext.state.launchTargetName || '');

    // Hook up event handlers
    // Listen for the variant to change
    this._variantManager.onActiveVariantChanged(() => {
      log.debug(localize('active.build.variant.changed', 'Active build variant changed'));
      rollbar.invokeAsync(localize('changing.build.variant', 'Changing build variant'), async () => {
        const drv = await this.getCMakeDriverInstance();
        if (drv) {
          await drv.setVariant(this._variantManager.activeVariantOptions, this._variantManager.activeKeywordSetting);
          this._activeVariant.set(this._variantManager.activeVariantOptions.short);
          // We don't configure yet, since someone else might be in the middle of a configure
        }
      });
    });
    this._ctestController.onTestingEnabledChanged(enabled => { this._ctestEnabled.set(enabled); });
    this._ctestController.onResultsChanged(res => { this._testResults.set(res); });

    this._statusMessage.set(localize('ready.status', 'Ready'));

    this.extensionContext.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async td => {
      const str = td.uri.fsPath.toLowerCase();
      if (str.endsWith("cmakelists.txt") || str.endsWith(".cmake")) {
        telemetry.logEvent("cmakeFileOpen");
      }
    }));

    this.extensionContext.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async td => {
      const str = td.uri.fsPath.toLowerCase();
      const drv = await this.getCMakeDriverInstance();

      // If we detect a change in the CMake cache file, refresh the webview
      if (this._cacheEditorWebview && drv && lightNormalizePath(str) === drv.cachePath.toLowerCase()) {
        await this._cacheEditorWebview.refreshPanel();
      }

      const sourceDirectory = (await this.sourceDir).toLowerCase();
      if (str === path.join(sourceDirectory, "cmakelists.txt")) {
        // CMakeLists.txt change event: its creation or deletion are relevant,
        // so update full/partial feature set view for this folder.
        await updateFullFeatureSetForFolder(this.folder);
        if (drv && !drv.configOrBuildInProgress()) {
          if (drv.config.configureOnEdit) {
            log.debug(localize('cmakelists.save.trigger.reconfigure', "Detected saving of CMakeLists.txt, attempting automatic reconfigure..."));
            await this.configureInternal(ConfigureTrigger.cmakeListsChange, [], ConfigureType.Normal);
          }
        } else {
          log.warning(localize('cmakelists.save.could.not.reconfigure',
           'Changes were detected in CMakeLists.txt but we could not reconfigure the project because another operation is already in progress.'));
          log.debug(localize('needs.reconfigure', 'The project needs to be reconfigured so that the changes saved in CMakeLists.txt have effect.'));
        }
      }

      // For multi-root, the "onDidSaveTextDocument" will be received once for each project folder.
      // To avoid misleading telemetry, consider the notification only for the active folder.
      // There is always one active folder in a workspace and never more than one.
      if (isActiveFolder(this.folder)) {
        // "outside" evaluates whether the modified cmake file belongs to the active folder.
        // Currently, we don't differentiate between outside active folder but inside any of the other
        // workspace folders versus outside any folder referenced by the current workspace.
        let outside: boolean = true;
        let fileType: string | undefined;
        if (str.endsWith("cmakelists.txt")) {
          fileType = "CMakeLists";

          // The CMakeLists.txt belongs to the current active folder only if sourceDirectory points to it.
          if (str === path.join(sourceDirectory, "cmakelists.txt")) {
            outside = false;
          }
        } else if (str.endsWith("cmakecache.txt")) {
          fileType = "CMakeCache";
          const binaryDirectory = (await this.binaryDir).toLowerCase();

          // The CMakeCache.txt belongs to the current active folder only if binaryDirectory points to it.
          if (str === path.join(binaryDirectory, "cmakecache.txt")) {
            outside = false;
          }
        } else if (str.endsWith(".cmake")) {
          fileType = ".cmake";
          const binaryDirectory = (await this.binaryDir).toLowerCase();

          // Instead of parsing how and from where a *.cmake file is included or imported
          // let's consider one inside the active folder if it's in the workspace folder,
          // sourceDirectory or binaryDirectory.
          if (str.startsWith(this.folder.uri.fsPath.toLowerCase()) ||
              str.startsWith(sourceDirectory) ||
              str.startsWith(binaryDirectory)) {
            outside = false;
          }
        }

        if (fileType) {
          telemetry.logEvent("cmakeFileWrite", { filetype: fileType, outsideActiveFolder: outside.toString() });
        }
      }
    }));
  }

  async isNinjaInstalled() : Promise<boolean> {
    const drv = await this._cmakeDriver;

    if (drv) {
      return await drv.testHaveCommand('ninja') || drv.testHaveCommand('ninja-build');
    }

    return false;
  }

  async setKit(kit: Kit|null) {
    this._activeKit = kit;
    if (kit) {
      log.debug(localize('injecting.new.kit', 'Injecting new Kit into CMake driver'));
      const drv = await this._cmakeDriver;  // Use only an existing driver, do not create one
      if (drv) {
        try {
          this._statusMessage.set(localize('reloading.status', 'Reloading...'));
          await drv.setKit(kit, this.getPreferredGenerators());
          this.workspaceContext.state.activeKitName = kit.name;
          this._statusMessage.set(localize('ready.status', 'Ready'));
        } catch (error) {
          vscode.window.showErrorMessage(localize('unable.to.set.kit', 'Unable to set kit "{0}".', error));
          this._statusMessage.set(localize('error.on.switch.status', 'Error on switch of kit ({0})', error.message));
          this._cmakeDriver = Promise.resolve(null);
          this._activeKit = null;
        }
      } else {
        // Remember the selected kit for the next session.
        this.workspaceContext.state.activeKitName = kit.name;
      }
    }
  }

  async getCMakeExecutable() {
    const overWriteCMakePathSetting = this.useCMakePresets ? this.configurePreset?.cmakeExecutable : undefined;
    let cmakePath = await this.workspaceContext.getCMakePath(overWriteCMakePathSetting);
    if (!cmakePath)
      cmakePath = '';
    const cmakeExe = await getCMakeExecutableInformation(cmakePath);
    if (cmakeExe.version && this.minCMakeVersion && versionLess(cmakeExe.version, this.minCMakeVersion)) {
      rollbar.error(localize('cmake.version.not.supported',
                             'CMake version {0} may not be supported. Minimum version required is {1}.',
                             versionToString(cmakeExe.version),
                             versionToString(this.minCMakeVersion)));
    }
    return cmakeExe;
  }

  /**
   * Returns, if possible a cmake driver instance. To creation the driver instance,
   * there are preconditions that should be fulfilled, such as an active kit is selected.
   * These preconditions are checked before it driver instance creation. When creating a
   * driver instance, this function waits until the driver is ready before returning.
   * This ensures that user commands can always be executed, because error criterials like
   * exceptions would assign a null driver and it is possible to create a new driver instance later again.
   */
  async getCMakeDriverInstance(): Promise<CMakeDriver|null> {
    return this._driverStrand.execute(async () => {
      if (!this.useCMakePresets && !this.activeKit) {
        log.debug(localize('not.starting.no.kits', 'Not starting CMake driver: no kits defined'));
        return null;
      }

      const cmake = await this.getCMakeExecutable();
      if (!cmake.isPresent) {
        vscode.window.showErrorMessage(localize('bad.executable', 'Bad CMake executable "{0}". Is it installed or settings contain the correct path (cmake.cmakePath)?', cmake.path));
        telemetry.logEvent('CMakeExecutableNotFound');
        return null;
      }

      if ((await this._cmakeDriver) === null) {
        log.debug(localize('starting.new.cmake.driver', 'Starting new CMake driver'));
        this._cmakeDriver = this._startNewCMakeDriver(cmake);

        try {
          await this._cmakeDriver;
        } catch (e) {
          this._cmakeDriver = Promise.resolve(null);
          if (e instanceof BadHomeDirectoryError) {
            vscode.window
                .showErrorMessage(localize('source.directory.does.not.match',
                    'The source directory "{0}" does not match the source directory in the CMake cache: {1}.  You will need to run a clean-configure to configure this project.', e.expecting, e.cached),
                    {},
                    {title: localize('clean.configure.title', 'Clean Configure')},
                    )
                .then(chosen => {
                  if (chosen) {
                    // There was only one choice: to clean-configure
                    rollbar.invokeAsync(localize('clean.reconfigure.after.bad.home.dir', 'Clean reconfigure after bad home dir'), async () => {
                      try {
                        await fs.unlink(e.badCachePath);
                      } catch (e2) { log.error(localize('failed.to.remove.bad.cache.file', 'Failed to remove bad cache file: {0} {1}', e.badCachePath, e2)); }
                      try {
                        await fs.rmdir(path.join(path.dirname(e.badCachePath), 'CMakeFiles'));
                      } catch (e2) { log.error(localize('failed.to.remove.cmakefiles.for.cache', 'Failed to remove CMakeFiles for cache: {0} {1}', e.badCachePath, e2)); }
                        await this.cleanConfigure(ConfigureTrigger.badHomeDir);
                      });
                  }
                });
          } else if (e instanceof NoGeneratorError) {
            const message = localize('generator.not.found', 'Unable to determine what CMake generator to use. Please install or configure a preferred generator, or update settings.json, your Kit configuration or PATH variable.');
            log.error(message, e);
            vscode.window.showErrorMessage(message);
          } else {
            throw e;
          }
          return null;
        }

        if (this._codeModelDriverSub) {
          this._codeModelDriverSub.dispose();
        }
        const drv = await this._cmakeDriver;
        console.assert(drv !== null, 'Null driver immediately after creation?');
        if (drv instanceof codemodel_api.CodeModelDriver) {
          this._codeModelDriverSub = drv.onCodeModelChanged(cm => { this._codeModel.set(cm); });
        }
      }

      return this._cmakeDriver;
    });
  }

  /**
   * Create an instance asynchronously
   * @param ctx The extension context
   *
   * The purpose of making this the only way to create an instance is to prevent
   * us from creating uninitialized instances of the CMake Tools extension.
   */
  static async create(ctx: vscode.ExtensionContext, wsc: DirectoryContext): Promise<CMakeTools> {
    log.debug(localize('safely.constructing.cmaketools', 'Safe constructing new CMakeTools instance'));
    const inst = new CMakeTools(ctx, wsc);
    await inst._init();
    log.debug(localize('initialization.complete', 'CMakeTools instance initialization complete.'));
    return inst;
  }

  /**
   * Create a new CMakeTools for the given directory.
   * @param folder Path to the directory for which to create
   * @param ext The extension context
   */
  static async createForDirectory(folder: vscode.WorkspaceFolder, ext: vscode.ExtensionContext): Promise<CMakeTools> {
    // Create a context for the directory
    const dir_ctx = DirectoryContext.createForDirectory(folder, new StateManager(ext, folder));
    return CMakeTools.create(ext, dir_ctx);
  }

  private _activeKit: Kit|null = null;
  get activeKit(): Kit|null { return this._activeKit; }

  /**
   * The compilation database for this driver.
   */
  private _compilationDatabase: CompilationDatabase|null = null;

  private async _refreshCompileDatabase(opts: ExpansionOptions): Promise<void> {
    const compdb_path = path.join(await this.binaryDir, 'compile_commands.json');
    if (await fs.exists(compdb_path)) {
      // Read the compilation database, and update our db property
      const new_db = await CompilationDatabase.fromFilePath(compdb_path);
      this._compilationDatabase = new_db;
      // Now try to copy the compdb to the user-requested path
      const copy_dest = this.workspaceContext.config.copyCompileCommands;
      if (!copy_dest) {
        return;
      }
      const expanded_dest = await expandString(copy_dest, opts);
      const pardir = path.dirname(expanded_dest);
      try {
        await fs.mkdir_p(pardir);
      } catch (e) {
        vscode.window.showErrorMessage(localize('failed.to.create.parent.directory',
          'Tried to copy "{0}" to "{1}", but failed to create the parent directory "{2}": {3}',
          compdb_path, expanded_dest, pardir, e.toString()));
        return;
      }
      try {
        await fs.copyFile(compdb_path, expanded_dest);
      } catch (e) {
        // Just display the error. It's the best we can do.
        vscode.window.showErrorMessage(localize('failed.to.copy', 'Failed to copy "{0}" to "{1}": {2}', compdb_path, expanded_dest, e.toString()));
        return;
      }
    }
  }

  /**
   * Implementation of `cmake.configure`
   * trigger: describes the circumstance that caused this configure to be run.
   *          In order to avoid a breaking change in the CMake Tools API,
   *          this parameter can default to that scenario.
   *          All other configure calls in this extension are able to provide
   *          proper trigger information.
   */
  configure(extra_args: string[] = []): Thenable<number> {
    return this.configureInternal(ConfigureTrigger.api, extra_args, ConfigureType.Normal);
  }

  configureInternal(trigger: ConfigureTrigger = ConfigureTrigger.api, extra_args: string[] = [], type: ConfigureType = ConfigureType.Normal): Thenable<number> {
    return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize('configuring.project', 'Configuring project'),
        },
        async progress => {
          progress.report({message: localize('preparing.to.configure', 'Preparing to configure')});
          log.info(localize('run.configure', 'Configuring folder: {0}', this.folderName), extra_args);
          return this._doConfigure(progress, async consumer => {
            const drv = await this.getCMakeDriverInstance();
            const IS_CONFIGURING_KEY = 'cmake:isConfiguring';
            if (drv) {
              let old_prog = 0;
              const prog_sub = drv.onProgress(pr => {
                const new_prog
                    = 100 * (pr.progressCurrent - pr.progressMinimum) / (pr.progressMaximum - pr.progressMinimum);
                const increment = new_prog - old_prog;
                if (increment >= 1) {
                  old_prog += increment;
                  progress.report({increment});
                }
              });
              try {
                progress.report({message: localize('configuring.project', 'Configuring project')});
                let retc: number;
                await setContextValue(IS_CONFIGURING_KEY, true);
                if (type == ConfigureType.Cache) {
                  retc = await drv.configure(trigger, [], consumer, true);
                } else {
                  switch (type) {
                    case ConfigureType.Normal:
                        retc = await drv.configure(trigger, extra_args, consumer);
                      break;
                    case ConfigureType.Clean:
                        retc = await drv.cleanConfigure(trigger, extra_args, consumer);
                      break;
                    default:
                        rollbar.error(localize('unexpected.configure.type', 'Unexpected configure type'), {type});
                        retc = await this.configureInternal(trigger, extra_args, ConfigureType.Normal);
                      break;
                  }
                  await setContextValue(IS_CONFIGURING_KEY, false);
                }
                if (retc === 0) {
                  await this._refreshCompileDatabase(drv.expansionOptions);
                }

                await this._ctestController.reloadTests(drv);
                this._onReconfiguredEmitter.fire();
                return retc;
              } finally {
                await setContextValue(IS_CONFIGURING_KEY, false);
                progress.report({message: localize('finishing.configure', 'Finishing configure')});
                prog_sub.dispose();
              }
            } else {
              progress.report({message: localize('configure.failed', 'Failed to configure project')});
              return -1;
            }
          });
        },
    );
  }

  /**
   * Implementation of `cmake.cleanConfigure()
   * trigger: describes the circumstance that caused this configure to be run.
   *          In order to avoid a breaking change in the CMake Tools API,
   *          this parameter can default to that scenario.
   *          All other configure calls in this extension are able to provide
   *          proper trigger information.
   */
  cleanConfigure(trigger: ConfigureTrigger = ConfigureTrigger.api) { return this.configureInternal(trigger, [], ConfigureType.Clean); }

  /**
   * Save all open files. "maybe" because the user may have disabled auto-saving
   * with `config.saveBeforeBuild`.
   */
  async maybeAutoSaveAll(): Promise<boolean> {
    // Save open files before we configure/build
    if (this.workspaceContext.config.saveBeforeBuild) {
      log.debug(localize('saving.open.files.before', 'Saving open files before configure/build'));
      const save_good = await vscode.workspace.saveAll();
      if (!save_good) {
        log.debug(localize('saving.open.files.failed', 'Saving open files failed'));
        const yesButtonTitle: string = localize('yes.button', 'Yes');
        const chosen = await vscode.window.showErrorMessage<
            vscode.MessageItem>(localize('not.saved.continue.anyway', 'Not all open documents were saved. Would you like to continue anyway?'),
                                {
                                  title: yesButtonTitle,
                                  isCloseAffordance: false,
                                },
                                {
                                  title: localize('no.button', 'No'),
                                  isCloseAffordance: true,
                                });
        return chosen !== undefined && (chosen.title === yesButtonTitle);
      }
    }
    return true;
  }

  /**
   * Wraps pre/post configure logic around an actual configure function
   * @param cb The actual configure callback. Called to do the configure
   */
  private async _doConfigure(progress: ProgressHandle,
                             cb: (consumer: CMakeOutputConsumer) => Promise<number>): Promise<number> {
    progress.report({message: localize('saving.open.files', 'Saving open files')});
    if (!await this.maybeAutoSaveAll()) {
      return -1;
    }
    if (!this.useCMakePresets) {
      if (!this.activeKit) {
        throw new Error(localize('cannot.configure.no.kit', 'Cannot configure: No kit is active for this CMake Tools'));
      }
      if (!this._variantManager.haveVariant) {
        progress.report({message: localize('waiting.on.variant', 'Waiting on variant selection')});
        await this._variantManager.selectVariant();
        if (!this._variantManager.haveVariant) {
          log.debug(localize('no.variant.abort', 'No variant selected. Abort configure'));
          return -1;
        }
      }
    } else if (!this.configurePreset){
      throw new Error(localize('cannot.configure.no.config.preset', 'Cannot configure: No configure preset is active for this CMake Tools'));
    }
    log.showChannel();
    const consumer = new CMakeOutputConsumer(await this.sourceDir, CMAKE_LOGGER);
    const retc = await cb(consumer);
    populateCollection(diagCollections.cmake, consumer.diagnostics);
    return retc;
  }

  /**
   * Get the name of the "all" target; that is, the target name for which CMake
   * will build all default targets.
   *
   * This is required because simply using `all` as the target name is incorrect
   * for some generators, such as Visual Studio and Xcode.
   *
   * This is async because it depends on checking the active generator name
   */
  get allTargetName() { return this._allTargetName(); }
  private async _allTargetName(): Promise<string> {
    const drv = await this.getCMakeDriverInstance();
    if (drv) {
      return drv.allTargetName;
    } else {
      return '';
    }
  }

  /**
   * Check if the current project needs to be (re)configured
   */
  private async _needsReconfigure(): Promise<boolean> {
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      return true;
    }

    const needsReconfigure: boolean = await drv.checkNeedsReconfigure();

    const skipConfigureIfCachePresent = this.workspaceContext.config.skipConfigureIfCachePresent;
    if (skipConfigureIfCachePresent && needsReconfigure && await fs.exists(drv.cachePath)) {
      log.info(localize('warn.skip.configure.when.cache.present',
                          'The extension determined that a configuration is needed at this moment \
                          but we are skipping because the setting cmake.skipConfigureWhenCachePresent is ON. \
                          Make sure the CMake cache is in sync with the latest configuration changes.'));
      return false;
    }

    return needsReconfigure;
  }

  async ensureConfigured(): Promise<number|null> {
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      return null;
    }
    // First, save open files
    if (!await this.maybeAutoSaveAll()) {
      return -1;
    }
    if (await this._needsReconfigure()) {
      return this.configureInternal(ConfigureTrigger.compilation, [], ConfigureType.Normal);
    } else {
      return 0;
    }
  }

  async tasksBuildCommandDrv(drv: CMakeDriver): Promise<string | null> {
    const target = this.useCMakePresets ? undefined : (this.workspaceContext.state.defaultBuildTarget || drv.allTargetName);
    const buildargs = await drv.getCMakeBuildCommand(target);
    return (buildargs) ? buildCmdStr(buildargs.command, buildargs.args) : null;
  }

  /**
   * Implementation of `cmake.tasksBuildCommand`
   */
  async tasksBuildCommand(): Promise<string|null> {
    const drv = await this.getCMakeDriverInstance();
    return drv ? this.tasksBuildCommandDrv(drv) : null;
  }

  private m_promise_build: Promise<number> = Promise.resolve(0);

  /**
   * Implementation of `cmake.build`
   */
  async runBuild(target_?: string): Promise<number> {
    log.info(localize('run.build', 'Building folder: {0}', this.folderName), target_ ? target_ : '');
    const config_retc = await this.ensureConfigured();
    if (config_retc === null) {
      throw new Error(localize('unable.to.configure', 'Build failed: Unable to configure the project'));
    } else if (config_retc !== 0) {
      return config_retc;
    }
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      throw new Error(localize('driver.died.after.successful.configure', 'CMake driver died immediately after successful configure'));
    }
    let target = target_;
    let targetName: string;
    if (this.useCMakePresets) {
      target = target;
      targetName = this.buildPreset?.displayName || this.buildPreset?.name || '';
    } else {
      target = target || this.workspaceContext.state.defaultBuildTarget || await this.allTargetName;
      targetName = target;
    }
    await this.reRegisterTaskProviderforNewTarget(drv, target);
    const consumer = new CMakeBuildConsumer(BUILD_LOGGER);
    const IS_BUILDING_KEY = 'cmake:isBuilding';
    try {
      this._statusMessage.set(localize('building.status', 'Building'));
      this._isBusy.set(true);
      return await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: localize('building.target', 'Building: {0}', targetName),
            cancellable: true,
          },
          async (progress, cancel) => {
            let old_progress = 0;
            consumer.onProgress(pr => {
              const increment = pr.value - old_progress;
              if (increment >= 1) {
                progress.report({increment});
                old_progress += increment;
              }
            });
          cancel.onCancellationRequested(() => { rollbar.invokeAsync(localize('stop.on.cancellation', 'Stop on cancellation'), () => this.stop()); });
          log.showChannel();
          BUILD_LOGGER.info(localize('starting.build', 'Starting build'));
          await setContextValue(IS_BUILDING_KEY, true);
          const rc = await drv.build(target, consumer);
          await setContextValue(IS_BUILDING_KEY, false);
          if (rc === null) {
            BUILD_LOGGER.info(localize('build.was.terminated', 'Build was terminated'));
          } else {
            BUILD_LOGGER.info(localize('build.finished.with.code', 'Build finished with exit code {0}', rc));
          }
          const file_diags = consumer.compileConsumer.resolveDiagnostics(drv.binaryDir);
          populateCollection(diagCollections.build, file_diags);
          return rc === null ? -1 : rc;
        },
      );
    } finally {
      await setContextValue(IS_BUILDING_KEY, false);
      this._statusMessage.set(localize('ready.status', 'Ready'));
      this._isBusy.set(false);
      consumer.dispose();
    }
  }
  /**
   * Implementation of `cmake.build`
   */
  async build(target_?: string): Promise<number> {
    this.m_promise_build = this.runBuild(target_);
    return this.m_promise_build;
  }

  /**
   * Attempt to execute the compile command associated with the file. If it
   * fails for _any reason_, returns `null`. Otherwise returns the terminal in
   * which the compilation is running
   * @param filePath The path to a file to try and compile
   */
  async tryCompileFile(filePath: string): Promise<vscode.Terminal|null> {
    const config_retc = await this.ensureConfigured();
    if (config_retc === null || config_retc !== 0) {
      // Config failed?
      return null;
    }
    if (!this._compilationDatabase) {
      return null;
    }
    const cmd = this._compilationDatabase.get(filePath);
    if (!cmd) {
      return null;
    }
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      return null;
    }
    return drv.runCompileCommand(cmd);
  }

  async editCache(): Promise<void> {
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      vscode.window.showErrorMessage(localize('set.up.before.edit.cache', 'Set up your CMake project before trying to edit the cache.'));
      return;
    }

    if (!await fs.exists(drv.cachePath)) {
      const do_conf = !!(await vscode.window.showErrorMessage(
        localize('project.not.yet.configured', 'This project has not yet been configured'),
        localize('configure.now.button', 'Configure Now')));
      if (do_conf) {
        if (await this.configureInternal() !== 0)
          return;
      } else {
        return;
      }
    }

    vscode.workspace.openTextDocument(vscode.Uri.file(drv.cachePath))
        .then(doc => { vscode.window.showTextDocument(doc); });
  }

    /**
   * Implementation of `cmake.EditCacheUI`
   */
  async editCacheUI(): Promise<number> {
    if (!this._cacheEditorWebview) {
      const drv = await this.getCMakeDriverInstance();
      if (!drv) {
        vscode.window.showErrorMessage(localize('cache.load.failed', 'No CMakeCache.txt file has been found. Please configure project first!'));
        return 1;
      }

      this._cacheEditorWebview = new ConfigurationWebview(drv.cachePath, async () => {
        await this.configureInternal(ConfigureTrigger.commandEditCacheUI, [], ConfigureType.Cache);
      });
      await this._cacheEditorWebview.initPanel();

      this._cacheEditorWebview.panel.onDidDispose(() => {
        this._cacheEditorWebview = undefined;
      });
    } else {
      this._cacheEditorWebview.panel.reveal();
    }

    return 0;
  }

  async buildWithTarget(): Promise<number> {
    const target = await this.showTargetSelector();
    if (target === null)
      return -1;
    return this.build(target);
  }

  async showTargetSelector(): Promise<string|null> {
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      vscode.window.showErrorMessage(localize('set.up.before.selecting.target', 'Set up your CMake project before selecting a target.'));
      return '';
    }

    if (!drv.targets.length) {
      return (await vscode.window.showInputBox({prompt: localize('enter.target.name', 'Enter a target name')})) || null;
    } else {
      const choices = drv.uniqueTargets.map((t): vscode.QuickPickItem => {
        switch (t.type) {
        case 'named': {
          return {
            label: t.name,
            description: localize('target.to.build.description', 'Target to build'),
          };
        }
        case 'rich': {
          return {label: t.name, description: t.targetType, detail: t.filepath};
        }
        }
      });
      const sel = await vscode.window.showQuickPick(choices);
      return sel ? sel.label : null;
    }
  }

  /**
   * Implementaiton of `cmake.clean`
   */
  async clean(): Promise<number> { return this.build('clean'); }

  /**
   * Implementation of `cmake.cleanRebuild`
   */
  async cleanRebuild(): Promise<number> {
    const clean_res = await this.clean();
    if (clean_res !== 0)
      return clean_res;
    return this.build();
  }

  private readonly _ctestController = new CTestDriver(this.workspaceContext);
  async ctest(): Promise<number> {

    const build_retc = await this.build();
    if (build_retc !== 0) {
      this._ctestController.markAllCurrentTestsAsNotRun();
      return build_retc;
    }

    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      throw new Error(localize('driver.died.after.build.succeeded', 'CMake driver died immediately after build succeeded.'));
    }
    return this._ctestController.runCTest(drv);
  }

  /**
   * Implementation of `cmake.install`
   */
  async install(): Promise<number> { return this.build('install'); }

  /**
   * Implementation of `cmake.stop`
   */
  async stop(): Promise<boolean> {
    const drv = await this._cmakeDriver;
    if (!drv) {
      return false;
    }

    return drv.stopCurrentProcess().then(async () => {
      await this.m_promise_build;
      this._cmakeDriver = Promise.resolve(null);
      this._isBusy.set(false);
      return true;
    }, () => false);
  }

  /**
   * Implementation of `cmake.setVariant`
   */
  async setVariant(name?: string) {
    // Make this function compatibile with return code style...
    if (await this._variantManager.selectVariant(name)) {
      await this.configureInternal(ConfigureTrigger.setVariant, [], ConfigureType.Normal);
      return 0; // succeeded
    }
    return 1; // failed
  }

  /**
   * The target that will be built with a regular build invocation
   */
  public get defaultBuildTarget(): string|null { return this.workspaceContext.state.defaultBuildTarget; }
  private async _setDefaultBuildTarget(v: string) {
    this.workspaceContext.state.defaultBuildTarget = v;
    this._targetName.set(v);
  }

  /**
   * Set the default target to build. Implementation of `cmake.setDefaultTarget`
   * @param target If specified, set this target instead of asking the user
   */
  async setDefaultTarget(target?: string|null) {
    if (!target) {
      target = await this.showTargetSelector();
    }
    if (!target) {
      return;
    }
    await this._setDefaultBuildTarget(target);
    const drv = await this._cmakeDriver;
    await this.reRegisterTaskProviderforNewTarget(drv, target);
  }

  async reRegisterTaskProviderforNewTarget(drv: CMakeDriver | null, target: string | undefined) {
    if (drv && (this.useCMakePresets || target)) {
      const buildargs = await drv.getCMakeBuildCommand(target);
      const command = (buildargs) ? buildCmdStr(buildargs.command, buildargs.args) : null;
      await registerTaskProvider(command);
    }
  }

  /**
   * Implementation of `cmake.getBuildTargetName`
   */
  async buildTargetName(): Promise<string|null> {
    return this.workspaceContext.state.defaultBuildTarget || this.allTargetName;
  }

  /**
   * Implementation of `cmake.selectLaunchTarget`
   */
  async selectLaunchTarget(name?: string): Promise<string|null> { return this.setLaunchTargetByName(name); }

  /**
   * Used by vscode and as test interface
   */
  async setLaunchTargetByName(name?: string|null) {
    if (await this._needsReconfigure()) {
      const rc = await this.configureInternal(ConfigureTrigger.launch, [], ConfigureType.Normal);
      if (rc !== 0) {
        return null;
      }
    }
    const executableTargets = await this.executableTargets;
    if (executableTargets.length === 0) {
      return null;
    } if (executableTargets.length === 1) {
      const target = executableTargets[0];
      this.workspaceContext.state.launchTargetName = target.name;
      this._launchTargetName.set(target.name);
      return target.path;
    }

    const choices = executableTargets.map(e => ({
                                            label: e.name,
                                            description: '',
                                            detail: e.path,
                                          }));
    let chosen: {label: string, detail: string}|undefined = undefined;
    if (!name) {
      chosen = await vscode.window.showQuickPick(choices, {placeHolder: localize('select.a.launch.target', 'Select a launch target for {0}', this.folder.name)});
    } else {
      chosen = choices.find(choice => choice.label == name);
    }
    if (!chosen) {
      return null;
    }
    this.workspaceContext.state.launchTargetName = chosen.label;
    this._launchTargetName.set(chosen.label);
    return chosen.detail;
  }

  async getCurrentLaunchTarget(): Promise<api.ExecutableTarget|null> {
    const target_name = this.workspaceContext.state.launchTargetName;
    const target = (await this.executableTargets).find(e => e.name == target_name);

    if (!target) {
      return null;
    }
    return target;
  }

  /**
   * Implementation of `cmake.launchTargetPath`. This also ensures the target exists if `cmake.buildBeforeRun` is set.
   */
  async launchTargetPath(): Promise<string|null> {
    const executable = await this.prepareLaunchTargetExecutable();
    if (!executable) {
      log.showChannel();
      log.warning('=======================================================');
      log.warning(localize('no.executable.target.found.to.launch', 'No executable target was found to launch. Please check:'));
      log.warning(` - ${localize('have.you.called.add_executable', 'Have you called add_executable() in your CMake project?')}`);
      log.warning(` - ${localize('have.you.configured', 'Have you executed a successful CMake configure?')}`);
      log.warning(localize('no.program.will.be.executed', 'No program will be executed'));
      return null;
    }
    return executable.path;
  }

  /**
   * Implementation of `cmake.launchTargetDirectory`. This also ensures the target exists if `cmake.buildBeforeRun` is set.
   */
  async launchTargetDirectory(): Promise<string|null> {
    const targetPath = await this.launchTargetPath();
    if (targetPath === null) {
      return null;
    }
    return path.dirname(targetPath);
  }

  /**
   * Implementation of `cmake.launchTargetFilename`. This also ensures the target exists if `cmake.buildBeforeRun` is set.
   */
  async launchTargetFilename(): Promise<string|null> {
    const targetPath = await this.launchTargetPath();
    if (targetPath === null) {
      return null;
    }
    return path.basename(targetPath);
  }

  /**
   * Implementation of `cmake.getLaunchTargetPath`. This does not ensure the target exists.
   */
  async getLaunchTargetPath(): Promise<string|null> {
    if (await this._needsReconfigure()) {
      const rc = await this.configureInternal(ConfigureTrigger.launch, [], ConfigureType.Normal);
      if (rc !== 0) {
        return null;
      }
    }
    const target = await this.getOrSelectLaunchTarget();
    if (!target) {
      log.showChannel();
      log.warning('=======================================================');
      log.warning(localize('no.executable.target.found.to.launch', 'No executable target was found to launch. Please check:'));
      log.warning(` - ${localize('have.you.called.add_executable', 'Have you called add_executable() in your CMake project?')}`);
      log.warning(` - ${localize('have.you.configured', 'Have you executed a successful CMake configure?')}`);
      log.warning(localize('no.program.will.be.executed', 'No program will be executed'));
      return null;
    }

    return target.path;
  }

  /**
   * Implementation of `cmake.getLaunchTargetDirectory`. This does not ensure the target exists.
   */
  async getLaunchTargetDirectory(): Promise<string|null> {
    const targetPath = await this.getLaunchTargetPath();
    if (targetPath === null) {
      return null;
    }
    return path.dirname(targetPath);
  }

  /**
   * Implementation of `cmake.getLaunchTargetFilename`. This does not ensure the target exists.
   */
  async getLaunchTargetFilename(): Promise<string|null> {
    const targetPath = await this.getLaunchTargetPath();
    if (targetPath === null) {
      return null;
    }
    return path.basename(targetPath);
  }

  /**
   * Implementation of `cmake.buildType`
   */
  async currentBuildType(): Promise<string|null> {
    return this._variantManager.activeVariantOptions.buildType || null;
  }

  /**
   * Implementation of `cmake.buildDirectory`
   */
  async buildDirectory(): Promise<string|null> {
    const binaryDir = await this.binaryDir;
    if (binaryDir) {
      return binaryDir;
    } else {
      return null;
    }
  }

  /**
   * Implementation of `cmake.buildKit`
   */
  async buildKit(): Promise<string|null> {
    if (this.activeKit) {
      return this.activeKit.name;
    } else {
      return null;
    }
  }

  async prepareLaunchTargetExecutable(name?: string): Promise<api.ExecutableTarget|null> {
    let chosen: api.ExecutableTarget;

    // Ensure that we've configured the project already. If we haven't, `getOrSelectLaunchTarget` won't see any
    // executable targets and may show an uneccessary prompt to the user
    const isReconfigurationNeeded = await this._needsReconfigure();
    if (isReconfigurationNeeded) {
      const rc = await this.configureInternal(ConfigureTrigger.launch, [], ConfigureType.Normal);
      if (rc !== 0) {
        log.debug(localize('project.configuration.failed', 'Configuration of project failed.'));
        return null;
      }
    }

    if (name) {
      const found = (await this.executableTargets).find(e => e.name === name);
      if (!found) {
        return null;
      }
      chosen = found;
    } else {
      const current = await this.getOrSelectLaunchTarget();
      if (!current) {
        return null;
      }
      chosen = current;
    }

    const buildOnLaunch = this.workspaceContext.config.buildBeforeRun;
    if (buildOnLaunch || isReconfigurationNeeded) {
      const rc_build = await this.build(chosen.name);
      if (rc_build !== 0) {
        log.debug(localize('build.failed', 'Build failed'));
        return null;
      }
    }

    return chosen;
  }

  async getOrSelectLaunchTarget(): Promise<api.ExecutableTarget|null> {
    const current = await this.getCurrentLaunchTarget();
    if (current) {
      return current;
    }
    // Ask the user if we don't already have a target
    await this.selectLaunchTarget();
    return this.getCurrentLaunchTarget();
  }

  /**
   * Implementation of `cmake.debugTarget`
   */
  async debugTarget(name?: string): Promise<vscode.DebugSession|null> {
    const drv = await this.getCMakeDriverInstance();
    if (!drv) {
      vscode.window.showErrorMessage(localize('set.up.and.build.project.before.debugging', 'Set up and build your CMake project before debugging.'));
      return null;
    }
    if (drv instanceof LegacyCMakeDriver) {
      vscode.window
          .showWarningMessage(localize('target.debugging.unsupported', 'Target debugging is no longer supported with the legacy driver'), {
            title: localize('learn.more.button', 'Learn more'),
            isLearnMore: true,
          })
          .then(item => {
            if (item && item.isLearnMore) {
              open('https://vector-of-bool.github.io/docs/vscode-cmake-tools/debugging.html');
            }
          });
      return null;
    }

    const targetExecutable = await this.prepareLaunchTargetExecutable(name);
    if (!targetExecutable) {
      log.error(localize('failed.to.prepare.target', 'Failed to prepare executable target with name \'{0}\'', name));
      return null;
    }

    let debug_config;
    try {
      const cache = await CMakeCache.fromPath(drv.cachePath);
      debug_config = await debugger_mod.getDebugConfigurationFromCache(cache, targetExecutable, process.platform,
                                                                       this.workspaceContext.config.debugConfig?.MIMode,
                                                                       this.workspaceContext.config.debugConfig?.miDebuggerPath);
      log.debug(localize('debug.configuration.from.cache', 'Debug configuration from cache: {0}', JSON.stringify(debug_config)));
    } catch (error) {
      vscode.window
          .showErrorMessage(error.message, {
            title: localize('debugging.documentation.button', 'Debugging documentation'),
            isLearnMore: true,
          })
          .then(item => {
            if (item && item.isLearnMore) {
              open('https://vector-of-bool.github.io/docs/vscode-cmake-tools/debugging.html');
            }
          });
      log.debug(localize('problem.getting.debug', 'Problem getting debug configuration from cache.'), error);
      return null;
    }

    if (debug_config === null) {
      log.error(localize('failed.to.generate.debugger.configuration', 'Failed to generate debugger configuration'));
      vscode.window.showErrorMessage(localize('unable.to.generate.debugging.configuration', 'Unable to generate a debugging configuration.'));
      return null;
    }

    // add debug configuration from settings
    const user_config = this.workspaceContext.config.debugConfig;
    Object.assign(debug_config, user_config);
    log.debug(localize('starting.debugger.with', 'Starting debugger with following configuration.'), JSON.stringify({
      workspace: this.folder.uri.toString(),
      config: debug_config,
    }));

    const cfg = vscode.workspace.getConfiguration('cmake', this.folder.uri).inspect<object>('debugConfig');
    const customSetting = (cfg?.globalValue !== undefined || cfg?.workspaceValue !== undefined || cfg?.workspaceFolderValue !== undefined);
    let dbg = debug_config.MIMode;
    if (!dbg && debug_config.type === "cppvsdbg") {
      dbg = "vsdbg";
    }
    const telemetryProperties: telemetry.Properties = {
      customSetting: customSetting.toString(),
      debugger: dbg
    };

    telemetry.logEvent('debug', telemetryProperties);

    await vscode.debug.startDebugging(this.folder, debug_config);
    return vscode.debug.activeDebugSession!;
  }

  private _launchTerminal?: vscode.Terminal;
  // Watch for the user closing our terminal
  private readonly _termCloseSub = vscode.window.onDidCloseTerminal(term => {
    if (term === this._launchTerminal) {
      this._launchTerminal = undefined;
    }
  });

  /**
   * Implementation of `cmake.launchTarget`
   */
  async launchTarget(name?: string) {
    const executable = await this.prepareLaunchTargetExecutable(name);
    if (!executable) {
      // The user has nothing selected and cancelled the prompt to select
      // a target.
      return null;
    }
    const user_config = this.workspaceContext.config.debugConfig;
    const termOptions: vscode.TerminalOptions = {
      name: 'CMake/Launch',
      cwd: (user_config && user_config.cwd) || path.dirname(executable.path),
    };
    if (process.platform == 'win32') {
      // Use cmd.exe on Windows
      termOptions.shellPath = paths.windows.ComSpec;
    }
    if (!this._launchTerminal)
      this._launchTerminal = vscode.window.createTerminal(termOptions);
    const quoted = shlex.quote(executable.path);

    let launchArgs = '';
    if (user_config && user_config.args) {
        launchArgs = user_config.args.join(" ");
    }

    this._launchTerminal.sendText(`${quoted} ${launchArgs}`);
    this._launchTerminal.show(true);
    return this._launchTerminal;
  }

  /**
   * Implementation of `cmake.quickStart`
   */
  public async quickStart(cmtFolder?: CMakeToolsFolder): Promise<Number> {
    if (!cmtFolder) {
      vscode.window.showErrorMessage(localize('no.folder.open', 'No folder is open.'));
      return -2;
    }

    const sourceDir = await this.sourceDir;
    const mainListFile = path.join(sourceDir, 'CMakeLists.txt');

    if (await fs.exists(mainListFile)) {
      vscode.window.showErrorMessage(localize('workspace.already.contains.cmakelists', 'This workspace already contains a CMakeLists.txt!'));
      return -1;
    }

    const project_name = await vscode.window.showInputBox({
      prompt: localize('new.project.name', 'Enter a name for the new project'),
      validateInput: (value: string): string => {
        if (!value.length)
          return localize('project.name.required', 'A project name is required');
        return '';
      },
    });
    if (!project_name)
      return -1;

    const target_type = (await vscode.window.showQuickPick([
      {
        label: 'Library',
        description: localize('create.library', 'Create a library'),
      },
      {label: 'Executable', description: localize('create.executable', 'Create an executable')}
    ]));

    if (!target_type)
      return -1;

    const type = target_type.label;

    const init = [
      'cmake_minimum_required(VERSION 3.0.0)',
      `project(${project_name} VERSION 0.1.0)`,
      '',
      'include(CTest)',
      'enable_testing()',
      '',
      type == 'Library' ? `add_library(${project_name} ${project_name}.cpp)`
                        : `add_executable(${project_name} main.cpp)`,
      '',
      'set(CPACK_PROJECT_NAME ${PROJECT_NAME})',
      'set(CPACK_PROJECT_VERSION ${PROJECT_VERSION})',
      'include(CPack)',
      '',
    ].join('\n');

    if (type === 'Library') {
      if (!(await fs.exists(path.join(sourceDir, project_name + '.cpp')))) {
        await fs.writeFile(path.join(sourceDir, project_name + '.cpp'), [
          '#include <iostream>',
          '',
          'void say_hello(){',
          `    std::cout << "Hello, from ${project_name}!\\n";`,
          '}',
          '',
        ].join('\n'));
      }
    } else {
      if (!(await fs.exists(path.join(sourceDir, 'main.cpp')))) {
        await fs.writeFile(path.join(sourceDir, 'main.cpp'), [
          '#include <iostream>',
          '',
          'int main(int, char**) {',
          '    std::cout << "Hello, world!\\n";',
          '}',
          '',
        ].join('\n'));
      }
    }
    await fs.writeFile(mainListFile, init);
    const doc = await vscode.workspace.openTextDocument(mainListFile);
    await vscode.window.showTextDocument(doc);

    // By now, quickStart is succesful in creating a valid CMakeLists.txt.
    // Regardless of the following configure return code,
    // we want full feature set view for the whole workspace.
    enableFullFeatureSet(true);
    return this.configureInternal(ConfigureTrigger.quickStart, [], ConfigureType.Normal,);
  }

  /**
   * Implementation of `cmake.resetState`
   */
  async resetState() {
    this.workspaceContext.state.reset();
  }

  get sourceDir() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return '';
      }
      return d.sourceDir;
    });
  }

  get mainListFile() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return '';
      }
      return d.mainListFile;
    });
  }

  get binaryDir() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return '';
      }
      return d.binaryDir;
    });
  }

  get cachePath() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return '';
      }
      return d.cachePath;
    });
  }

  get targets() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return [];
      }
      return d.targets;
    });
  }

  get executableTargets() {
    const drv = this.getCMakeDriverInstance();

    return drv.then(d => {
      if (!d) {
        return [];
      }
      return d.executableTargets;
    });
  }

  async jumpToCacheFile() {
    // Do nothing.
    return null;
  }

  async setBuildType() {
    // Do nothing
    return -1;
  }

  async selectEnvironments() { return null; }
}

export default CMakeTools;

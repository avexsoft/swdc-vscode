import { commands, Disposable, workspace } from "vscode";
import {
    handleCodeTimeLogin,
    handleKpmClickedEvent,
    updatePreferences
} from "./DataController";
import {
    displayCodeTimeMetricsDashboard,
    showMenuOptions
} from "./MenuManager";
import { launchWebUrl, handleCodeTimeStatusToggle } from "./Util";
import { KpmController } from "./KpmController";

export function createCommands(): {
    dispose: () => void;
} {
    let cmds = [];

    //
    // Add the keystroke controller to the ext ctx, which
    // will then listen for text document changes.
    //
    const kpmController = new KpmController();

    cmds.push(kpmController);

    const kpmClickedCmd = commands.registerCommand(
        "codetime.softwareKpmDashboard",
        () => {
            handleKpmClickedEvent();
        }
    );
    cmds.push(kpmClickedCmd);

    const loginCmd = commands.registerCommand("codetime.codeTimeLogin", () => {
        handleCodeTimeLogin();
    });
    cmds.push(loginCmd);

    const codeTimeMetricsCmd = commands.registerCommand(
        "codetime.codeTimeMetrics",
        () => {
            displayCodeTimeMetricsDashboard();
        }
    );
    cmds.push(codeTimeMetricsCmd);

    const paletteMenuCmd = commands.registerCommand(
        "codetime.softwarePaletteMenu",
        () => {
            showMenuOptions();
        }
    );
    cmds.push(paletteMenuCmd);

    const top40Cmd = commands.registerCommand(
        "codetime.viewSoftwareTop40",
        () => {
            launchWebUrl("https://api.software.com/music/top40");
        }
    );
    cmds.push(top40Cmd);

    const toggleStatusInfoCmd = commands.registerCommand(
        "codetime.codeTimeStatusToggle",
        () => {
            handleCodeTimeStatusToggle();
        }
    );
    cmds.push(toggleStatusInfoCmd);

    const configChangesHandler = workspace.onDidChangeConfiguration(e =>
        updatePreferences()
    );
    cmds.push(configChangesHandler);

    return Disposable.from(...cmds);
}

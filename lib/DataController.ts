import { workspace, ConfigurationTarget, window } from "vscode";

import {
    softwareGet,
    softwarePut,
    isResponseOk,
    softwarePost
} from "./HttpClient";
import {
    getItem,
    setItem,
    getSoftwareDataStoreFile,
    deleteFile,
    nowInSecs,
    getOsUsername,
    getSessionFileCreateTime,
    getOs,
    getVersion,
    getHostname,
    getEditorSessionToken,
    showOfflinePrompt,
    buildLoginUrl,
    launchWebUrl,
    logIt,
    getPluginId,
    logEvent
} from "./Util";
import {
    buildWebDashboardUrl,
    fetchCodeTimeMetricsDashboard,
    clearMetricsDashboardLastCheckDate
} from "./MenuManager";
import {
    getSessionSummaryData,
    updateStatusBarWithSummaryData,
    saveSessionSummaryToDisk
} from "./OfflineManager";
import { DEFAULT_SESSION_THRESHOLD_SECONDS } from "./Constants";
const fs = require("fs");
const moment = require("moment-timezone");

let loggedInCacheState = null;
let lastLoggedInCheckTime = null;
let serverAvailable = true;
let serverAvailableLastCheck = 0;
let toggleFileEventLogging = null;

let userFetchTimeout = null;

// batch offline payloads in 50. backend has a 100k body limit
const batch_limit = 50;

let statusBarLastDayHour = null;

export function isNewHour() {
    const dayHr = moment().format("YYYY-MM-DD-HH");

    if (!statusBarLastDayHour || dayHr !== statusBarLastDayHour) {
        statusBarLastDayHour = dayHr;
        return true;
    }

    return false;
}

export function clearStatusBarLastDayHour() {
    statusBarLastDayHour = null;
}

async function resetFetchTimeChecks() {
    clearMetricsDashboardLastCheckDate();
    clearStatusBarLastDayHour();
}

export function getLoggedInCacheState() {
    return loggedInCacheState;
}

export function getToggleFileEventLoggingState() {
    if (toggleFileEventLogging === null) {
        toggleFileEventLogging = workspace
            .getConfiguration()
            .get("toggleFileEventLogging");
    }
    return toggleFileEventLogging;
}

export async function serverIsAvailable() {
    let nowSec = nowInSecs();
    let diff = nowSec - serverAvailableLastCheck;
    if (serverAvailableLastCheck === 0 || diff > 60) {
        serverAvailableLastCheck = nowInSecs();
        serverAvailable = await softwareGet("/ping", null)
            .then(result => {
                return isResponseOk(result);
            })
            .catch(e => {
                return false;
            });
    }
    return serverAvailable;
}

export async function sendBatchPayload(batch) {
    await softwarePost("/data/batch", batch, getItem("jwt")).catch(e => {
        logIt(`Unable to send plugin data batch, error: ${e.message}`);
    });
}

/**
 * send the offline data
 */
export async function sendOfflineData() {
    let isonline = await serverIsAvailable();
    if (!isonline) {
        return;
    }
    const dataStoreFile = getSoftwareDataStoreFile();
    try {
        if (fs.existsSync(dataStoreFile)) {
            const content = fs.readFileSync(dataStoreFile).toString();
            // we're online so just delete the datastore file
            deleteFile(getSoftwareDataStoreFile());
            if (content) {
                logEvent(`sending batch payloads: ${content}`);
                const payloads = content
                    .split(/\r?\n/)
                    .map(item => {
                        let obj = null;
                        if (item) {
                            try {
                                obj = JSON.parse(item);
                            } catch (e) {
                                //
                            }
                        }
                        if (obj) {
                            return obj;
                        }
                    })
                    .filter(item => item);

                // send 50 at a time
                let batch = [];
                for (let i = 0; i < payloads.length; i++) {
                    if (batch.length >= batch_limit) {
                        await sendBatchPayload(batch);
                        batch = [];
                    }
                    batch.push(payloads[i]);
                }
                if (batch.length > 0) {
                    await sendBatchPayload(batch);
                }
            }
        }
    } catch (e) {
        //
    }

    // update the statusbar (only fetch if it's a new day)
    await fetchSessionSummaryInfo();
}

/**
 * send any music tracks
 */
export async function sendMusicData(trackData) {
    if (trackData.available_markets) {
        delete trackData.available_markets;
    }
    if (trackData.images) {
        delete trackData.images;
    }
    if (trackData.external_urls) {
        delete trackData.external_urls;
    }
    if (trackData.href) {
        delete trackData.href;
    }

    logIt(`sending ${JSON.stringify(trackData)}`);
    // add the "local_start", "start", and "end"
    // POST the kpm to the PluginManager
    let api = `/music/session`;
    return softwarePost(api, trackData, getItem("jwt"))
        .then(resp => {
            if (!isResponseOk(resp)) {
                return { status: "fail" };
            }
            return { status: "ok" };
        })
        .catch(e => {
            return { status: "fail" };
        });
}

/**
 * get the app jwt
 */
export async function getAppJwt(serverIsOnline) {
    if (serverIsOnline) {
        // get the app jwt
        let resp = await softwareGet(
            `/data/apptoken?token=${nowInSecs()}`,
            null
        );
        if (isResponseOk(resp)) {
            return resp.data.jwt;
        }
    }
    return null;
}

/**
 * create an anonymous user based on github email or mac addr
 */
export async function createAnonymousUser(serverIsOnline) {
    let appJwt = await getAppJwt(serverIsOnline);
    if (appJwt && serverIsOnline) {
        const jwt = getItem("jwt");
        // check one more time before creating the anon user
        if (!jwt) {
            const creation_annotation = "NO_SESSION_FILE";
            const username = await getOsUsername();
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const hostname = await getHostname();
            let resp = await softwarePost(
                "/data/onboard",
                {
                    timezone,
                    username,
                    creation_annotation,
                    hostname
                },
                appJwt
            );
            if (isResponseOk(resp) && resp.data && resp.data.jwt) {
                setItem("jwt", resp.data.jwt);
                return resp.data.jwt;
            }
        }
    }
    return null;
}

async function isLoggedOn(serverIsOnline) {
    let jwt = getItem("jwt");
    if (serverIsOnline && jwt) {
        let api = "/users/plugin/state";
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp) && resp.data) {
            // NOT_FOUND, ANONYMOUS, OK, UNKNOWN
            let state = resp.data.state ? resp.data.state : "UNKNOWN";
            if (state === "OK") {
                let sessionEmail = getItem("name");
                let email = resp.data.email;
                if (sessionEmail !== email) {
                    setItem("name", email);
                }
                // check the jwt
                let pluginJwt = resp.data.jwt;
                if (pluginJwt && pluginJwt !== jwt) {
                    // update it
                    setItem("jwt", pluginJwt);
                }

                let checkStatus = getItem("check_status");
                if (checkStatus) {
                    // update it to null, they've logged in
                    setItem("check_status", null);
                }

                return { loggedOn: true, state };
            }
            // return the state that is returned
            return { loggedOn: false, state };
        }
    }
    return { loggedOn: false, state: "UNKNOWN" };
}

/**
 * check if the user is registered or not
 * return {loggedIn: true|false}
 */
export async function getUserStatus(serverIsOnline, ignoreCache = false) {
    if (!ignoreCache && loggedInCacheState) {
        // ignore cache is true and we have a logged in cache state
        if (lastLoggedInCheckTime) {
            const threshold = 60 * 5;
            // check to see if we should invalide the check time
            if (moment().unix() - lastLoggedInCheckTime > threshold) {
                // set logged in cache state to null as well as the check time
                lastLoggedInCheckTime = null;
                loggedInCacheState = null;
            }
        } else {
            // it's null, set it
            lastLoggedInCheckTime = moment().unix();
        }
        return loggedInCacheState;
    }

    let loggedIn = false;
    if (serverIsOnline) {
        // refetch the jwt then check if they're logged on
        const loggedInResp = await isLoggedOn(serverIsOnline);
        // set the loggedIn bool value
        loggedIn = loggedInResp.loggedOn;
    }

    logIt(`Checking login status, logged in: ${loggedIn}`);

    loggedInCacheState = {
        loggedIn
    };

    if (!loggedIn) {
        let name = getItem("name");
        // only update the name if it's not null
        if (name) {
            setItem("name", null);
        }
    }

    if (serverIsOnline && loggedIn) {
        sendHeartbeat(`STATE_CHANGE:LOGGED_IN:${loggedIn}`, serverIsOnline);

        if (loggedIn) {
            // they've logged in, update the preferences
            initializePreferences(serverIsOnline);
        }

        setTimeout(() => {
            // update the statusbar
            fetchSessionSummaryInfo();
        }, 1000);
    }

    return loggedInCacheState;
}

export async function getUser(serverIsOnline, jwt) {
    if (jwt && serverIsOnline) {
        let api = `/users/me`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (resp && resp.data && resp.data.data) {
                const user = resp.data.data;
                if (user.registered === 1) {
                    // update jwt to what the jwt is for this spotify user
                    setItem("name", user.email);

                    loggedInCacheState = { loggedIn: true };
                }
                return user;
            }
        }
    }
    return null;
}

export async function initializePreferences(serverIsOnline) {
    let jwt = getItem("jwt");
    // use a default if we're unable to get the user or preferences
    let sessionThresholdInSec = DEFAULT_SESSION_THRESHOLD_SECONDS;

    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (user && user.preferences) {
            // obtain the session threshold in seconds "sessionThresholdInSec"
            sessionThresholdInSec =
                user.preferences.sessionThresholdInSec ||
                DEFAULT_SESSION_THRESHOLD_SECONDS;

            let userId = parseInt(user.id, 10);
            let prefs = user.preferences;
            let prefsShowMusic =
                prefs.showMusic !== null && prefs.showMusic !== undefined
                    ? prefs.showMusic
                    : null;
            let prefsShowGit =
                prefs.showGit !== null && prefs.showGit !== undefined
                    ? prefs.showGit
                    : null;
            let prefsShowRank =
                prefs.showRank !== null && prefs.showRank !== undefined
                    ? prefs.showRank
                    : null;

            if (
                prefsShowMusic === null ||
                prefsShowGit === null ||
                prefsShowRank === null
            ) {
                await sendPreferencesUpdate(userId, prefs);
            } else {
                if (prefsShowMusic !== null) {
                    // await workspace
                    //     .getConfiguration()
                    //     .update(
                    //         "showMusicMetrics",
                    //         prefsShowMusic,
                    //         ConfigurationTarget.Global
                    //     );
                    // updateShowMusicMetrics(prefsShowMusic);
                }
                if (prefsShowGit !== null) {
                    await workspace
                        .getConfiguration()
                        .update(
                            "showGitMetrics",
                            prefsShowGit,
                            ConfigurationTarget.Global
                        );
                }
                if (prefsShowRank !== null) {
                    // await workspace
                    //     .getConfiguration()
                    //     .update(
                    //         "showWeeklyRanking",
                    //         prefsShowRank,
                    //         ConfigurationTarget.Global
                    //     );
                }
            }
        }
    }

    // update the session threshold in seconds config
    setItem("sessionThresholdInSec", sessionThresholdInSec);
}

async function sendPreferencesUpdate(userId, userPrefs) {
    let api = `/users/${userId}`;
    // let showMusicMetrics = workspace.getConfiguration().get("showMusicMetrics");
    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    // let showWeeklyRanking = workspace
    //     .getConfiguration()
    //     .get("showWeeklyRanking");
    // userPrefs["showMusic"] = showMusicMetrics;
    userPrefs["showGit"] = showGitMetrics;
    // userPrefs["showRank"] = showWeeklyRanking;

    // updateShowMusicMetrics(showMusicMetrics);

    // update the preferences
    // /:id/preferences
    api = `/users/${userId}/preferences`;
    let resp = await softwarePut(api, userPrefs, getItem("jwt"));
    if (isResponseOk(resp)) {
        logIt("update user code time preferences");
    }
}

export async function updatePreferences() {
    toggleFileEventLogging = workspace
        .getConfiguration()
        .get("toggleFileEventLogging");

    // let showMusicMetrics = workspace.getConfiguration().get("showMusicMetrics");
    let showGitMetrics = workspace.getConfiguration().get("showGitMetrics");
    // let showWeeklyRanking = workspace
    //     .getConfiguration()
    //     .get("showWeeklyRanking");

    // updateShowMusicMetrics(showMusicMetrics);

    // get the user's preferences and update them if they don't match what we have
    let jwt = getItem("jwt");
    let serverIsOnline = await serverIsAvailable();
    if (jwt && serverIsOnline) {
        let user = await getUser(serverIsOnline, jwt);
        if (!user) {
            return;
        }
        let api = `/users/${user.id}`;
        let resp = await softwareGet(api, jwt);
        if (isResponseOk(resp)) {
            if (
                resp &&
                resp.data &&
                resp.data.data &&
                resp.data.data.preferences
            ) {
                let prefs = resp.data.data.preferences;
                let prefsShowMusic =
                    prefs.showMusic !== null && prefs.showMusic !== undefined
                        ? prefs.showMusic
                        : null;
                let prefsShowGit =
                    prefs.showGit !== null && prefs.showGit !== undefined
                        ? prefs.showGit
                        : null;
                let prefsShowRank =
                    prefs.showRank !== null && prefs.showRank !== undefined
                        ? prefs.showRank
                        : null;

                if (prefsShowGit === null || prefsShowGit !== showGitMetrics) {
                    await sendPreferencesUpdate(parseInt(user.id, 10), prefs);
                }
            }
        }
    }
}

export function refetchUserStatusLazily(tryCountUntilFoundUser = 40) {
    if (userFetchTimeout) {
        return;
    }
    userFetchTimeout = setTimeout(() => {
        userFetchTimeout = null;
        userStatusFetchHandler(tryCountUntilFoundUser);
    }, 10000);
}

async function userStatusFetchHandler(tryCountUntilFoundUser) {
    let serverIsOnline = await serverIsAvailable();
    let userStatus = await getUserStatus(serverIsOnline, true);
    if (!userStatus.loggedIn) {
        // try again if the count is not zero
        if (tryCountUntilFoundUser > 0) {
            tryCountUntilFoundUser -= 1;
            refetchUserStatusLazily(tryCountUntilFoundUser);
        } else {
            // set the check_status to true
            setItem("check_status", true);
        }
    } else {
        // clear the last moment date to be able to retrieve the user's dashboard metrics
        resetFetchTimeChecks();
        const message = "Successfully logged on to Code Time";

        window.showInformationMessage(message);
    }
}

export async function sendHeartbeat(reason, serverIsOnline) {
    let jwt = getItem("jwt");
    if (serverIsOnline && jwt) {
        let heartbeat = {
            pluginId: getPluginId(),
            os: getOs(),
            start: nowInSecs(),
            version: getVersion(),
            hostname: await getHostname(),
            session_ctime: getSessionFileCreateTime(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            trigger_annotation: reason,
            editor_token: getEditorSessionToken()
        };
        let api = `/data/heartbeat`;
        softwarePost(api, heartbeat, jwt).then(async resp => {
            if (!isResponseOk(resp)) {
                logIt("unable to send heartbeat ping");
            }
        });
    }
}

export async function handleCodeTimeLogin() {
    if (!(await serverIsAvailable())) {
        showOfflinePrompt(false);
    } else {
        let loginUrl = await buildLoginUrl();
        launchWebUrl(loginUrl);
        // each retry is 10 seconds long
        refetchUserStatusLazily();
    }
}

export async function handleKpmClickedEvent() {
    let serverIsOnline = await serverIsAvailable();
    // {loggedIn: true|false}
    let userStatus = await getUserStatus(serverIsOnline);
    let webUrl = await buildWebDashboardUrl();

    if (!userStatus.loggedIn) {
        webUrl = await buildLoginUrl();
        refetchUserStatusLazily();
    }
    launchWebUrl(webUrl);
}

export async function fetchSessionSummaryInfo() {
    // make sure we send the beginning of the day
    let result = await getSessionSummaryStatus();

    if (result.status === "OK") {
        fetchCodeTimeMetricsDashboard(result.data);
    }
}

export async function getSessionSummaryStatus() {
    let sessionSummaryData = getSessionSummaryData();
    let status = "OK";

    // check if we need to get new dashboard data
    if (isNewHour()) {
        let serverIsOnline = await serverIsAvailable();
        if (serverIsOnline) {
            // Provides...
            // data: { averageDailyKeystrokes:982.1339, averageDailyKpm:26, averageDailyMinutes:38,
            // currentDayKeystrokes:8362, currentDayKpm:26, currentDayMinutes:332.99999999999983,
            // currentSessionGoalPercent:0, dailyMinutesGoal:38, inFlow:true, lastUpdatedToday:true,
            // latestPayloadTimestamp:1573050489, liveshareMinutes:null, timePercent:876, velocityPercent:100,
            // volumePercent:851 }
            const result = await softwareGet(
                `/sessions/summary`,
                getItem("jwt")
            ).catch(err => {
                return null;
            });
            if (isResponseOk(result) && result.data) {
                // get the lastStart
                const lastStart = sessionSummaryData.lastStart;
                // update it from the app
                sessionSummaryData = result.data;
                sessionSummaryData.lastStart = lastStart;
                // update the file
                saveSessionSummaryToDisk(sessionSummaryData);
            } else {
                status = "NO_DATA";
            }
        }
    }

    updateStatusBarWithSummaryData();
    return { data: sessionSummaryData, status };
}

var Promise = require("bluebird");
var google = require("googleapis");
var fs = require("fs");
var tl = require("vso-task-lib");
var publisher = google.androidpublisher("v2");

// User inputs
var key = require(tl.getPathInput("serviceAccountKey", true));
var packageName = tl.getPathInput("packageName", true);
var sourceTrack = tl.getInput("sourceTrack", true);
var destinationTrack = tl.getInput("destinationTrack", true);
var userFraction = tl.getInput("userFraction", false); // Used for staged rollouts

// Constants
var GOOGLE_PLAY_SCOPES = ["https://www.googleapis.com/auth/androidpublisher"];
var APK_MIME_TYPE = "application/vnd.android.package-archive";

var globalParams = { auth: null, params: {} };

var jwtClient = setupAuthClient(key);
var edits = publisher.edits;
[edits, edits.tracks, jwtClient].forEach(Promise.promisifyAll);

globalParams.auth = jwtClient;
updateGlobalParams("packageName", packageName);

console.log("Authenticating with Google Play");
var currentEdit = authorize().then(function (res) {
    return getNewEdit(packageName);
});

currentEdit = currentEdit.then(function (res) {
    console.log("Getting information for track " + sourceTrack);
    return getTrack(packageName, sourceTrack);
});

currentEdit = currentEdit.then(function (res) {
    console.log("Promoting to track " + destinationTrack);
    return updateTrack(packageName, destinationTrack, res[0].versionCodes, userFraction);
});

currentEdit = currentEdit.then(function (res) {
    console.log("Cleaning up track " + sourceTrack);
    return updateTrack(packageName, sourceTrack, [], userFraction);
});

currentEdit = currentEdit.then(function (res) {
    return edits.commitAsync().then(function (res) {
        console.log("APK successfully promoted!");
        console.log("Source Track: " + sourceTrack);
        console.log("Destination Track: " + destinationTrack);
        tl.exit(0);
    });
}).catch(function (err) {
    console.error(err);
    tl.exit(1);
});



/**
 * Tries to extract the package name from an apk file
 * @param {Object} apkFile - The apk file from which to attempt name extraction
 * @return {string} packageName - Name extracted from package. null if extraction failed
 */
function tryGetPackageName(apkFile) {
    tl.debug("Candidate package: " + apkFile);
    var packageName = null;
    try {
        packageName = apkParser
            .readFile(apkFile)
            .readManifestSync()
        .package;

        tl.debug("name extraction from apk succeeded: " + packageName);
    }
    catch (e) {
        tl.debug("name extraction from apk failed: " + e.message);
        console.error("The specified APK file isn't valid. Please check the path and try to queue another build.");
    }

    return packageName;
}

/**
 * Setups up a new JWT client for authentication
 * @param {Object} key - parsed object from google play provided JSON authentication informatoin
 * @return {Object} client - Returns object to be used for authenticating calls to the api.
 */
function setupAuthClient(key) {
    return new google.auth.JWT(key.client_email, null, key.private_key, GOOGLE_PLAY_SCOPES, null);
}

function authorize() {
    return jwtClient.authorizeAsync();
}

/**
 * Uses the provided JWT client to request a new edit from the Play store and attach the edit id to all requests made this session
 * Assumes authorized
 * @param {string} packageName - unique android package name (com.android.etc)
 * @return {Promise} edit - A promise that will return result from inserting a new edit
 *                          { id: string, expiryTimeSeconds: string }
 */
function getNewEdit(packageName) {
    tl.debug("Creating a new edit");
    var requestParameters = {
        packageName: packageName
    };

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));

    return edits.insertAsync(requestParameters).then(function (res) {
        updateGlobalParams("editId", res[0].id);
        return res;
    });
}

function getTrack(packageName, track) {
    tl.debug("Getting Track information");
    var requestParameters = {
        packageName: packageName,
        track: track
    };

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));
    
    return edits.track.getAsync(requestParameters);
}

/**
 * Update a given release track with the given information
 * Assumes authorized
 * @param {string} packageName - unique android package name (com.android.etc)
 * @param {string} track - one of the values {"alpha", "beta", "production", "rollout"}
 * @param {integer or [integers]} versionCode - version code returned from an apk call. will take either a number or a [number]
 * @param {double} userFraction - for rollout, fraction of users to get update
 * @returns {Promise} track - A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function updateTrack(packageName, track, versionCode, userFraction) {
    tl.debug("Updating track");
    var requestParameters = {
        packageName: packageName,
        track: track,
        resource: {
            track: track,
            versionCodes: (typeof versionCode === "number", [versionCode], versionCode)
        }
    };

    if (track == "rollout") {
        requestParameters.resource.userFraction = userFraction;
    }

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));

    return edits.tracks.updateAsync(requestParameters);
}

/**
 * Add a changelog to an edit
 * Assumes authorized
 * @param {string} changeLogFile - path to changelog file. We assume this exists (behaviour may change)
 * @returns {Promise} track - A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function addChangelog(changeLogFile) {
    tl.debug("Adding changelog file: " + changeLogFile);
    var requestParameters = {
        apkVersionCode: globalParams.params.apkVersionCode,
        language: "en-US",
        resource: {
            language: "en-US",
            recentChanges: fs.readFileSync(changeLogFile)
        }
    };

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));
    return edits.tracks.patchAsync(requestParameters);
}
/**
 * Update the universal parameters attached to every request
 * @param {string} paramName - Name of parameter to add/update
 * @param {any} value - value to assign to paramName. Any value is admissible.
 * @returns {void} void
 */

function updateGlobalParams(paramName, value) {
    tl.debug("Updating Global Parameters");
    tl.debug("SETTING " + paramName + " TO " + JSON.stringify(value));
    globalParams.params[paramName] = value;
    google.options(globalParams);
    tl.debug("Global Params set to " + JSON.stringify(globalParams));
}

// Future features:
// ----------------
// 1) Adding testers
// 2) Adding new images
// 3) Adding expansion files
// 4) Updating contact info
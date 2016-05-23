var Promise = require("bluebird");
var google = require("googleapis");
var fs = require("fs");
var path = require("path");
var tl = require("vso-task-lib");
var apkParser = require("node-apk-parser");
var publisher = google.androidpublisher("v2");
var glob = require("glob");

// User inputs;
var authType = tl.getInput("authType", true);
var key = {};
if (authType === "JsonFile") {
    var serviceAccountKeyFile = tl.getPathInput("serviceAccountKey", false);
    try {
        var stats = fs.statSync(serviceAccountKeyFile);
        if (stats && stats.isFile()) {
            key = require(serviceAccountKeyFile);
        } else {
            console.error("Specified Auth file was invalid");
            tl.setResult(1, serviceAccountKeyFile + " was not a valid auth file");
        }
    } catch (e) { }
} else if (authType === "ServiceEndpoint") {
    var serviceEndpoint = tl.getEndpointAuthorization(tl.getInput("serviceEndpoint", true));
    key.client_email = serviceEndpoint.parameters.username;
    key.private_key = serviceEndpoint.parameters.password.replace(/\\n/g, "\n");
}

var apkFile = resolveGlobPath(tl.getPathInput("apkFile", true));
var apkFileList = [apkFile];
var additionalApks = tl.getDelimitedInput("additionalApks", "\n");
if (additionalApks.length > 0) {
    for (var i in additionalApks) {
        apkFileList.push(resolveGlobPath(additionalApks[i]));
    }

    console.log("Found multiple Apks to upload: ");
    console.log(apkFileList);
}

var track = tl.getInput("track", true);
var userFraction = tl.getInput("userFraction", false); // Used for staged rollouts
var  changelogFile = tl.getInput(" changelogFile", false);
var shouldAttachMetadata = tl.getBoolInput("shouldAttachMetadata", false);

// Constants
var GOOGLE_PLAY_SCOPES = ["https://www.googleapis.com/auth/androidpublisher"];
var APK_MIME_TYPE = "application/vnd.android.package-archive";

var globalParams = { auth: null, params: {} };

// The submission process is composed
// of a transction with the following steps:
// -----------------------------------------
// #1) Extract the package name from the specified APK file
// #2) Get an OAuth token by authentincating the service account
// #3) Create a new editing transaction
// #4) Upload the new APK(s)
// #5) Specify the track that should be used for the new APK (e.g. alpha, beta)
// #6) Specify the new change log
// #7) Commit the edit transaction

var packageName = tryGetPackageName(apkFile);
var jwtClient = setupAuthClient(key);
var edits = publisher.edits;
[edits, edits.apks, edits.tracks, jwtClient].forEach(Promise.promisifyAll);

globalParams.auth = jwtClient;
updateGlobalParams("packageName", packageName);

console.log("Authenticating with Google Play");
var currentEdit = authorize().then(function (res) {
    return getNewEdit(packageName);
});

for (var apk in apkFileList) {
    currentEdit = currentEdit.then(function (res) {
        console.log(`Uploading APK file ${apkFileList[apk]}...`);
        return addApk(packageName, apkFileList[apk]);
    });
}

if (shouldAttachMetadata) {
    currentEdit = currentEdit.then(function (res) {
        console.log(`Attempting to attach metadata to release...`);
        return addMetadata(".");
    })
}

currentEdit = currentEdit.then(function (res) {
    console.log("Updating track information...");
    return updateTrack(packageName, track, res[0].versionCode, userFraction);
});

// This block will likely be deprecated by the metadata awareness
try {
    var stats = fs.statSync( changelogFile);
    if (stats && stats.isFile()) {
        currentEdit = currentEdit.then(function (res) {
            console.log("Adding changelog file...");
            return addChangelog("en-US",  changelogFile);
        });

    }
} catch (e) {
    tl.debug("No changelog found. log path was " +  changelogFile);
}

currentEdit = currentEdit.then(function (res) {
    return edits.commitAsync().then(function (res) {
        console.log("APK successfully published!");
        console.log("Track: " + track);
        tl.exit(0);
    });
}).catch(function (err) {
    console.error(err);
    tl.exit(1);
});



/**
 * Tries to extract the package name from an apk file
 * @param {Object} apkFile The apk file from which to attempt name extraction
 * @return {string} packageName Name extracted from package. null if extraction failed
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
 * @param {Object} key parsed object from google play provided JSON authentication informatoin
 * @return {Object} client Returns object to be used for authenticating calls to the api.
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
 * @param {string} packageName unique android package name (com.android.etc)
 * @return {Promise} edit A promise that will return result from inserting a new edit
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

/**
 * Adds an apk to an existing edit
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @param {string} apkFile path to apk file
 * @returns {Promise} apk A promise that will return result from uploading an apk 
 *                          { versionCode: integer, binary: { sha1: string } }
 */
function addApk(packageName, apkFile) {
    tl.debug("Uploading a new apk: " + apkFile);
    var requestParameters = {
        packageName: packageName,
        media: {
            body: fs.createReadStream(apkFile),
            mimeType: APK_MIME_TYPE
        }
    };

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));

    return edits.apks.uploadAsync(requestParameters).then(function (res) {
        updateGlobalParams("apkVersionCode", res[0].versionCode)
        return res;
    })
}

/**
 * Update a given release track with the given information
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @param {string} track one of the values {"alpha", "beta", "production", "rollout"}
 * @param {(number|number[])} versionCode version code returned from an apk call. will take either a number or a number[]
 * @param {double} userFraction for rollout, fraction of users to get update
 * @returns {Promise} track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function updateTrack(packageName, track, versionCode, userFraction) {
    tl.debug("Updating track");
    var requestParameters = {
        packageName: packageName,
        track: track,
        resource: {
            track: track,
            versionCodes: (typeof versionCode === "number" ? [versionCode] : versionCode)
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
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string}  changelogFile path to changelog file. We assume this exists (behaviour may change)
 * @returns {Promise} track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function addChangelog(languageCode,  changelogFile) {
    tl.debug("Adding changelog file: " +  changelogFile);
    
    var versionCode = globalParams.params.apkVersionCode;
    try {
        var changelogVersion = changelogFile.replace(/\.[^/.]+$/g, "");
        versionCode = parseInt(changelogVersion);
    } catch (e) {
        tl.debug(e);
        tl.debug(`Failed to extract version code from file ${changelogFile}. Defaulting to global version code ${globalParams.params.apkVersionCode}`);
    }
    
    var requestParameters = {
        apkVersionCode: globalParams.params.apkVersionCode,
        language: languageCode,
        resource: {
            language: languageCode,
            recentChanges: fs.readFileSync(changelogFile)
        }
    };

    tl.debug("Additional Parameters: " + JSON.stringify(requestParameters));
    return edits.tracks.patchAsync(requestParameters);
}

/**
 * Attaches the metadata in the specified directory to the edit. Assumes the metadata structure specified by Fastlane.
 * Assumes authorized
 * 
 * Metadata Structure:
 * metadata
 *  └ $(languageCodes)
 *    ├ full_description.txt
 *    ├ short_description.txt
 *    ├ title.txt
 *    ├ video.txt
 *    ├ images
 *    |  ├ featureGraphic.png    || featureGraphic.jpg   || featureGraphic.jpeg
 *    |  ├ icon.png              || icon.jpg             || icon.jpeg
 *    |  ├ promoGraphic.png      || promoGraphic.jpg     || promoGraphic.jpeg
 *    |  ├ tvBanner.png          || tvBanner.jpg         || tvBanner.jpeg
 *    |  ├ phoneScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ sevenInchScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ tenInchScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ tvScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  └ wearScreenshots
 *    |     └ *.png || *.jpg || *.jpeg
 *    └ changelogs
 *      └ $(versioncodes).txt
 * 
 * @param {string} metadataDirectory Path to the folder where the Fastlane metadata structure is found
 * @returns {Promise}  A promise that will return the result from last metadata change that was attempted. Currently, this is most likely an image upload.
 *                     { image: { id: string, url: string, sha1: string } }
 */
function addMetadata(metadataDirectory) {
    tl.debug("Attempting to add metadata...");
    var metadataRootDirectory = path.join(metadataDirectory, "metadata");
    tl.debug(`Assuming root is at ${metadataDirectory}\n\rAdding metadata from ${metadataRootDirectory}`);

    var metadataLanguageCodes = fs.readdirSync(metadataRootDirectory).filter(function (subPath) {
        var pathIsDir = false;
        try {
            pathIsDir = fs.statSync(path.join(path2, subPath)).isDirectory();
        } catch (e) {
            tl.debug(e);
            tl.debug(`failed to stat path ${subPath}. ignoring...`);
        }

        return pathIsDir;
    });

    var addingAllMetadataPromise = Promise();

    for (var i in metadataLanguageCodes) {
        var nextLanguageCode = metadataLanguageCodes[i];
        addingAllMetadataPromise = addingAllMetadataPromise.then(function () {
            return uploadMetadataWithLanguageCode(nextLanguageCode, path.join(metadataDirectory, nextLanguageCode));
        });
    }

    return addingAllMetadataPromise;
}

/**
 * Updates the details for a language with new information
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Promise} A Promise that will return after all metadata updating operations are completed.
 */
function uploadMetadataWithLanguageCode(languageCode, directory) {
    tl.debug(`Attempting to upload metadata in ${directory} for language code ${languageCode}`);

    var updatingMetadataPromise;

    var patchListingRequestParameters = {
        language: languageCode
    };

    patchListingRequestParameters.resource = createPatchListingResource(languageCode, directory);

    updatingMetadataPromise = edits.listings.patchAsync(patchListingRequestParameters);
    var changelogDir = path.join(directory, "changelog");

    try {
        var changelogs = fs.readdirSync(changelogDir).filter(function (subPath) {
            var pathIsFile = false;
            try {
                pathIsFile = fs.statSync(path.join(changelogDir, subPath)).isFile();
            } catch (e) {
                tl.debug(`failed to stat path ${subPath}. ignoring...`);
            }

            return pathIsFile;
        });

        for (var i in changelogs) {
            updatingMetadataPromise = updatingMetadatPromise.then(function (changelog) {
                tl.debug(`Appending changelog ${changelog}`);
                return addChangelog.bind(this, languageCode, changelog)();
            }.bind(this, changelogs[i]));
        }
    } catch (e) {
        tl.debug(`no changelogs found in ${changelogDir}`);
    }

    updatingMetadataPromise = updatingMetadataPromise.then(function () {
        return attachImages.bind(this, languageCode, directory)();
    });

    return updatingMetadataPromise;
}

/**
 * Helper method for creating the resource for the edits.listings.patch method.
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Object} resource A crafted resource for the edits.listings.patch method.
 *                              { languageCode: string, fullDescription: string, shortDescription: string, title: string, video: string }
 */
function createPatchListingResource(languageCode, directory) {
    tl.debug(`Constructing resource to patch listing with language code ${languageCode} from ${directory}`);
    var resourceParts = {
        "fullDescription": "full_description.txt",
        "shortDescription": "short_description.txt",
        "title": "title.txt",
        "video": "video.txt"
    };

    var resouce = {
        language: languageCode
    };

    for (var i in resourceParts) {
        var file = path.join(directory, resourceParts[i]);
        var fileContents;
        try {
            fileContents = fs.readFileSync(file);
        } catch (e) {
            tl.debug(`Failed to read metadata file ${file}. Ignoring...`);
        }

        resource[i] = fileContents;
    }

    tl.debug(`Finished constructing resource ${resource}`);
    return resouce;
}

/**
 * Upload images to the app listing.
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Promise} response Response from last attempted image upload
 *                             { image: { id: string, url: string, sha1: string } }
 */
function attachImages(languageCode, directory) {
    tl.debug(`Starting upload of images with language code ${languageCode} from ${directory}`);
    var imageTypes = ["featureGraphic", "icon", "promoGraphic", "tvBanner", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots"];
    var acceptedExtensions = [".png", ".jpg", ".jpeg"];

    var uploadImagesPromise = Promise();
    for (var i in imageTypes) {
        var shouldAttemptUpload = false;
        var imageType = imageTypes[i];
        var imageUploadRequest = {
            language: languageCode,
            imageType: imageType,
            uploadType: "media"
        };

        tl.debug(`Attempting construction of request for image type ${imageType}`);
        switch (imageType) {
            case "featureGraphic":
            case "icon":
            case "promoGraphic":
            case "tvBanner":
                try {
                    for (var i = 0; i < acceptedExtensions.length && !shouldAttemptUpload; i++) {
                        var imageStat = fs.statSync(imageType + acceptedExtensions[i]);
                        if (imageStat) {
                            tl.debug(`Found image for type ${imageType}`);
                            shouldAttemptUpload = imageStat.isFile();
                        }
                    }
                } catch (e) {
                    tl.debug(`Image for ${imageType} was not found. Skipping...`);
                }
                break;
            case "phoneScreenshots":
            case "sevenInchScreenshots":
            case "tenInchScreenshots":
            case "tvScreenshots":
            case "wearScreenshots":
                try {
                    var imageStat = fs.statSync(imageType);
                    if (imageStat) {
                        tl.debug(`Found image for type ${imageType}`);
                        shouldAttemptUpload = imageStat.isDirectory();
                        if (!shouldAttemptUpload) {
                            tl.debug(`Stat returned that ${imageType} was not a directory. Is there a file that shares this name?`);
                        }
                    }
                } catch (e) {
                    tl.debug(`Image directory for ${imageType} was not found. Skipping...`);
                }
                break;
            default:
                tl.debug(`Image type ${imageType} is an unknown type and was ignored`);
                continue;
        }

        if (shouldAttemptUpload) {
            uploadImagesPromise = uploadImagesPromise.then(function () {
                return edits.images.uploadAsync.bind(this, imageUploadRequest)();
            });
            tl.debug(`Request construction complete and request queued.`);
        } else {
            tl.debug(`Upload of image type ${imageType} was skipped. Check log for details`);
        }
    }

    tl.debug(`All image uploads queued`);
    return uploadImagesPromise;
}

/**
 * Update the universal parameters attached to every request
 * @param {string} paramName Name of parameter to add/update
 * @param {any} value value to assign to paramName. Any value is admissible.
 * @returns {void} void
 */
function updateGlobalParams(paramName, value) {
    tl.debug("Updating Global Parameters");
    tl.debug("SETTING " + paramName + " TO " + JSON.stringify(value));
    globalParams.params[paramName] = value;
    google.options(globalParams);
    tl.debug("Global Params set to " + JSON.stringify(globalParams));
}

/**
 * Get the appropriate file from the provided pattern
 * @param {string} path The minimatch pattern of glob to be resolved to file path
 * @returns {string} path path of the file resolved by glob
 */
function resolveGlobPath(path) {
    if (path) {
        // VSTS tries to be smart when passing in paths with spaces in them by quoting the whole path. Unfortunately, this actually breaks everything, so remove them here.
        path = path.replace(/\"/g, "");

        var filesList = glob.sync(path);
        if (filesList.length > 0) {
            path = filesList[0];
        }
    }

    return path;
}


// Future features:
// ----------------
// 1) Adding testers
// 2) Adding new images
// 3) Adding expansion files
// 4) Updating contact info

// Import NPM Packages
// const admin = require('firebase-admin');
const functions = require("firebase-functions");
const iot = require("@google-cloud/iot");

// Client to interface with Google Cloud IoT devices
const client = new iot.v1.DeviceManagerClient();

// Name of Google Cloud (and Firebase) Project
const GCLOUD_PROJECT = "piponics";
const REGISTRY_ID = "RaspberryPis";
const IOT_REGION = "us-central1";

// start cloud function
exports.configUpdate = functions.firestore
    // assumes a document whose ID is the same as the deviceid
    .document("RaspberryPis/{deviceId}")
    .onWrite((change, context) => {
      if (context) {
        console.log("Updating device: ", context.params.deviceId);
        console.log("Configuration value: ", change.after.data());
        const request = generateRequest(context.params.deviceId,
            change.after.data());
        return client.modifyCloudToDeviceConfig(request);
      } else {
        throw (Error("no context from trigger"));
      }
    });

/**
 * Function to generate request to change Google Cloud IoT Device config
 *
 * @param {string} deviceId Google Cloud IoT Device name
 * @param {object} configData the configuration data to send
 *
 * @return {object} the formatted request to Google Cloud IoT
 */
function generateRequest(deviceId, configData) {
  const formattedName = client.devicePath(GCLOUD_PROJECT,
      IOT_REGION,
      REGISTRY_ID,
      deviceId);
  const dataValue = Buffer.from(JSON.stringify(configData)).toString("base64");

  return {
    name: formattedName,
    binaryData: dataValue,
  };
}

/*
 * File: index.js
 *
 * Purpose: Firebase functions that connect
 *          IoT devices to the piponics mobile
 *          application
 *
 * Author: Jayden Leong <jdleong58@gmail.com>
 *
 * Date: February 4, 2021
 */
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const iot = require("@google-cloud/iot");

admin.initializeApp();

// Reference to root of real-time database in Firebase
const database = admin.database();

// Client to interface with Google Cloud IoT devices
const client = new iot.v1.DeviceManagerClient();

// Configuration variables
const GCLOUD_PROJECT = "piponics";
const REGISTRY_ID = "RaspberryPis";
const IOT_REGION = "us-central1";
const IOT_TOPIC = "device-events";

/*
 * Function: iotDeviceConfigUpdate
 *
 * Listens to updates from Firestore collection,
 * then updates Google Cloud IoT device configurations.
 *
 * Assumes the IoT device registry name (REGISTRY_ID)
 * is the same as the Firestore collection,
 * and the IoT device name is the same as the
 * document ID. Visit Firestore console to see
 * database structure.
 */
exports.iotDeviceConfigUpdate = functions.firestore
    .document(REGISTRY_ID.concat("/{deviceId}"))
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

/*
 * Function: iotStoreDeviceUpdates
 *
 * Subscribes to IoT device updates in Google Pub-Sub,
 * then saves this to Firebase real-time database.
 * The mobile app pulls device status from this
 * real-time database.
 *
 * Assumes the IoT devices publish to IOT_TOPIC
 *
 * NOTE: this function does not work in emulator.
 *       This is for unknown reasons. Please deploy
 *       to test
 */
exports.iotStoreDeviceUpdates = functions.pubsub
    .topic(IOT_TOPIC)
    .onPublish((message) => {
      // Fetch data from PubSub topic
      const deviceId = message.attributes.deviceId;
      const deviceData = message.json;
      console.log("Recieved msg from: ", deviceId);
      console.log("Msg data: ", deviceData);

      // Write data to Firebase real-time db
      database.ref(deviceId).set(deviceData);

      return;
    });

/**
 * Generate request to change Google Cloud IoT Device config
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



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

// Reference to databases in Firebase
const database = admin.database();
const firestore = admin.firestore();

// Client to interface with Google Cloud IoT devices
const client = new iot.v1.DeviceManagerClient();

// Configuration variables
const GCLOUD_PROJECT = "piponics";
const REGISTRY_ID = "RaspberryPis";
const IOT_REGION = "us-central1";
const IOT_TOPIC = "device-events";
const STATUS_COLLECTION = "Status";
const HISTORY_COLLECTION = "History";
const CONFIG_COLLECTION = "Config";

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
    .document(CONFIG_COLLECTION.concat("/{deviceId}"))
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

      // Add timestamp to data
      deviceData.timestamp = admin.firestore.Timestamp.now(),

      // Write data to Firebase real-time db
      // TODO(Jayden): remove once migrated to Firestore
      database.ref(deviceId).set(deviceData);

      // Update sensor measurements in Firestore
      firestore.collection(STATUS_COLLECTION).doc(deviceId).update(deviceData);

      // Push the new message into Firestore using the Firebase Admin SDK.
      firestore.collection(HISTORY_COLLECTION)
          .doc(deviceId)
          .collection(HISTORY_COLLECTION)
          .add(deviceData);

      // Create a notification demo if the leak sensor is above a certain value
      // TODO(Jayden) Fetch thresholds from database,
      // programmable by user in notification settings.
      // (deviceId == "CarsonPi" || deviceId == "LynesPi"))
      /*
      if (deviceData.leak > 1.5 && deviceId == "LynesPi") {
        console.log("Leak Detected on System: ", deviceId);

        const payload = {
          notification: {
            title: "WARNING: LEAK DETECTED",
            body: "Please check your system to avoid damage...",
            sound: "default",
          },
        };

        //  Create an options object that contains the time to live
        //    for the notification and the priority
        const options = {
          priority: "high",
          timeToLive: 60 * 60 * 24,
        };

        // TODO(Jayden) Keep topic as constant
        return admin.messaging().sendToTopic("leakNotifications",
            payload,
            options);
      }
      */
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



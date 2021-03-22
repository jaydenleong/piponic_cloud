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
const ERROR_COLLECTION = "Error";

// Notification Messages
const GENERIC_WARN_MSG = "Please check your system to avoid damage...";
const TEMP_HIGH_MSG = "WARNING: TEMPERATURE TOO HIGH...";
const TEMP_LOW_MSG = "WARNING: TEMPERATURE TOO LOW...";

// Default Firestore database documents for Raspberry Pis
const DEFAULT_CONFIG_DOC = { // Default system settings
  max_ph: 10,
  max_temperature: 15,
  min_ph: 5,
  min_temperature: 25,
  peristaltic_pump_on: false,
  target_ph: 7,
};

const DEFAULT_ERROR_DOC = { // Default there are no errors
  PH_HIGH: false,
  PH_LOW: false,
  TEMP_HIGH: false,
  TEMP_LOW: false,
  WATER_LEVEL_LOW: false,
  BATTERY_LOW: false,
  LEAK_DETECTED: false,
};

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

/**
 * Gets system error information from Firestore. Error data includes
 * pH values out of range, battery level low, etc.
 *
 * @param {string} deviceId Raspberry Pi's Google Cloud IoT Device name
 *
 * @return {object} The error data for a device
 */
/*
async function getErrorDataForDevice(deviceId) {
  let errorData = null;

  await firestore.collection(ERROR_COLLECTION)
      .doc(deviceId).get().then((documentSnapshot) => {
        if (documentSnapshot.exists) {
          errorData = documentSnapshot.data();
        }
      });

  return errorData;
}
*/

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
      firestore.collection(STATUS_COLLECTION).doc(deviceId).set(deviceData);

      // Push the new message into Firestore using the Firebase Admin SDK.
      firestore.collection(HISTORY_COLLECTION)
          .doc(deviceId)
          .collection(HISTORY_COLLECTION)
          .add(deviceData);

      // Create a notification if sensor thresholds are surpassed
      return firestore.collection(CONFIG_COLLECTION)
          .doc(deviceId)
          .get().then((documentSnapshot) => {
            let piConfigData;

            // Create default configuration settings if none are found
            if (!documentSnapshot.exists) {
              console.log("[WARN] No configuaration status exists for: ",
                  deviceId, "creating default...");
              piConfigData = DEFAULT_CONFIG_DOC;
              firestore.collection(CONFIG_COLLECTION)
                  .doc(deviceId)
                  .set(piConfigData);
            } else { // Get configuration from Firestore if found
              piConfigData = documentSnapshot.data();
            }

            console.log("Config Data finish");
            console.log(piConfigData);

            // Get Error data for system
            firestore.collection(ERROR_COLLECTION)
                .doc(deviceId).get().then((documentSnapshot) => {
                  let piErrorData;

                  // Add default error data if none available
                  if (!documentSnapshot.exists) {
                    console.log("[WARN] No error settings exist for: ",
                        deviceId,
                        ", creating default...");

                    // Create default error settings
                    piErrorData = DEFAULT_ERROR_DOC;
                    firestore.collection(ERROR_COLLECTION)
                        .doc(deviceId)
                        .set(DEFAULT_ERROR_DOC);
                    return;
                  } else { // Fetch error data from Firebase Error collection
                    piErrorData = documentSnapshot.data();
                  }

                  console.log("Error Data finish");
                  console.log(piErrorData);

                  const options = {
                    priority: "high",
                    timeToLive: 60 * 60 * 24,
                  };

                  // TODO(Jayden): Get latest status value also

                  for (const [key, val] of Object.entries(piConfigData)) {
                  // Check that
                    switch (key) {
                      case "max_temperature":
                        if ("temperature" in deviceData) {
                          if (deviceData.temperature > val) {
                            const notificationMessage = {
                              notification: {
                                title: TEMP_HIGH_MSG,
                                body: GENERIC_WARN_MSG,
                                sound: "default",
                              },
                            };

                            // Send the notification
                            admin.messaging()
                                .sendToTopic(
                                    deviceId,
                                    notificationMessage,
                                    options);
                          }
                        }
                        break;
                      case "min_temperature":
                        console.log("Min temp");
                        if ("temperature" in deviceData) {
                          if (deviceData.temperature < val) {
                            console.log("Temp too low");
                            const notificationMessage = {
                              notification: {
                                title: TEMP_LOW_MSG,
                                body: GENERIC_WARN_MSG,
                                sound: "default",
                              },
                            };

                            // Send the notification
                            admin.messaging()
                                .sendToTopic(
                                    deviceId,
                                    notificationMessage,
                                    options);
                          }
                        }
                        break;
                      case "max_ph":
                        break;
                      case "min_ph":
                        break;
                      default:
                        break;
                    }
                  }
                });
          });
    });

/**
 * Generate request to change Google Cloud IoT Device config
 *
 * @param {string} deviceId Google Cloud IoT Device name
 * @param {object} configData the configuration data to send
 *
 * @return {object} the formatted request to Google Cloud IoT
 */
/*
function detectSystemErrors(deviceId, configData) {

}
*/
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



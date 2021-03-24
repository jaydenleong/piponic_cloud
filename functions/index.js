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
const TEMP_HIGH_MSG = "TEMPERATURE TOO HIGH...";
const TEMP_LOW_MSG = "TEMPERATURE TOO LOW...";
const PH_HIGH_MSG = "PH TOO HIGH...";
const PH_LOW_MSG = "PH TOO LOW...";
const BATTERY_LOW_MSG = "BATTERY TOO LOW..";
const INTERNAL_LEAK_MSG = "INTERNAL LEAK DETECTED...";
const LEAK_MSG = "LEAK DETECTED...";

// Default Firestore database documents for Raspberry Pis
const DEFAULT_CONFIG_DOC = { // Default system settings
  max_ph: 10,
  min_ph: 5,
  max_temperature: 25,
  min_temperature: 15,
  peristaltic_pump_on: false,
  target_ph: 7,
  update_interval_minutes: 30,
};

const DEFAULT_ERROR_DOC = { // Default there are no errors
  PH_HIGH: false,
  PH_LOW: false,
  TEMP_HIGH: false,
  TEMP_LOW: false,
  WATER_LEVEL_LOW: false,
  BATTERY_LOW: false,
  LEAK_DETECTED: false,
  INTERNAL_LEAK_DETECTED: false,
};

// Default Error values. Send errors if thresholds not maintained
const MIN_BATTERY_VOLTAGE = 4.0;
const MAX_LEAK_VOLTAGE = 0.6;

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
      firestore.collection(STATUS_COLLECTION).doc(deviceId).set(deviceData);

      // Push the new message into Firestore using the Firebase Admin SDK.
      firestore.collection(HISTORY_COLLECTION)
          .doc(deviceId)
          .collection(HISTORY_COLLECTION)
          .add(deviceData);

      // Fetch configuration data for this Raspberry Pi
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

            // Get Error data for this Raspberry Pi
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

                  // Send notifications to users if errors are encountered
                  // Also update Error collection in Firestore
                  detectSystemErrors(deviceId, deviceData,
                      piConfigData, piErrorData);
                });
          });
    });

/**
 * Detects errors in update from aquaponic/hydroponic system.
 * Sends notifications to devices using Firebase Cloud Messaging
 * if errors are detected.
 *
 * @param {string} deviceId Google Cloud IoT Device name
 * @param {object} deviceData sensor readings coming from RPi
 * @param {object} configData configuration of a device in Firestore
 * @param {object} errorData error status of device in Firestore
 *
 * @return {void}
 */
function detectSystemErrors(deviceId, deviceData, configData, errorData) {
  // Check configuration settings to see if any errors are detected
  // This includes low PH or temperature
  for ( const config in configData) {
    // Filter out any inherited properties
    if (!Object.prototype.hasOwnProperty.call(configData, config)) {
      continue;
    }

    // Check if there are any errors
    switch (config) {
      case "min_temperature":
        if ("temperature" in deviceData) {
          // Only check for error if temperature is being read
          if (deviceData.temperature < configData.min_temperature) {
            console.log("Temp too low");

            // Only send notification when error first occurs
            // Avoids duplicate user notifications
            if (!errorData.TEMP_LOW) {
              sendFCMNotification(deviceId,
                  deviceId + ": " + TEMP_LOW_MSG,
                  GENERIC_WARN_MSG);
            }

            // Update that there is an error detected
            errorData.TEMP_LOW = true;
          } else {
            errorData.TEMP_LOW = false;
          }
        }
        break;
      case "max_temperature":
        if ("temperature" in deviceData) {
          if (deviceData.temperature > configData.max_temperature) {
            console.log("Temp too high");

            if (!errorData.TEMP_HIGH) {
              sendFCMNotification(deviceId,
                  deviceId + ": " + TEMP_HIGH_MSG,
                  GENERIC_WARN_MSG);
            }

            // Update that there is an error detected
            errorData.TEMP_HIGH = true;
          } else {
            errorData.TEMP_HIGH = false;
          }
        }
        break;
      case "max_ph":
        if ("pH" in deviceData) {
          if (deviceData.pH > configData.max_ph) {
            console.log("pH too high");

            if (!errorData.PH_HIGH) {
              sendFCMNotification(deviceId,
                  deviceId + ": " + PH_HIGH_MSG,
                  GENERIC_WARN_MSG);
            }

            errorData.PH_HIGH = true;
          } else {
            errorData.PH_HIGH = false;
          }
        }
        break;
      case "min_ph":
        if ("pH" in deviceData) {
          if (deviceData.pH < configData.min_ph) {
            console.log("pH too low");

            if (!errorData.PH_LOW) {
              sendFCMNotification(deviceId,
                  deviceId + ": " + PH_LOW_MSG,
                  GENERIC_WARN_MSG);
            }

            errorData.PH_LOW = true;
          } else {
            errorData.PH_LOW = false;
          }
        }
        break;
      default:
        break;
    }
  }

  // Begin Check for other errors not in user configuration
  // Battery voltage low check
  if ("battery_voltage" in deviceData) {
    if (deviceData.battery_voltage < MIN_BATTERY_VOLTAGE) {
      console.log("Battery voltage too low");

      if (!errorData.BATTERY_LOW) {
        sendFCMNotification(deviceId,
            deviceId + ": " + BATTERY_LOW_MSG,
            GENERIC_WARN_MSG);
      }

      errorData.BATTERY_LOW = true;
    } else {
      errorData.BATTERY_LOW = false;
    }
  }

  // Internal (inside the sensor box) leak check
  if ("internal_leak" in deviceData) {
    if (deviceData.internal_leak > MAX_LEAK_VOLTAGE) {
      console.log("Internal leak detected");

      if (!errorData.INTERNAL_LEAK_DETECTED) {
        sendFCMNotification(deviceId,
            deviceId + " " + INTERNAL_LEAK_MSG,
            GENERIC_WARN_MSG);
      }

      errorData.INTERNAL_LEAK_DETECTED = true;
    } else {
      errorData.INTERNAL_LEAK_DETECTED = false;
    }
  }

  // Leak check
  if ("leak" in deviceData) {
    if (deviceData.leak > MAX_LEAK_VOLTAGE ) {
      console.log("Leak detected");

      if (!errorData.LEAK_DETECTED) {
        sendFCMNotification(deviceId,
            deviceId + ": " + LEAK_MSG,
            GENERIC_WARN_MSG);
      }

      errorData.LEAK_DETECTED = true;
    } else {
      errorData.LEAK_DETECTED = false;
    }
  }

  // Update error data in database
  firestore.collection(ERROR_COLLECTION).doc(deviceId).set(errorData);
}

/**
 * Sends Firebase Cloud Messaging (FCM) notification to a given topic.
 * The user will see the title and body text.
 *
 * @param {String} topic FCM topic name (user phones subscribe to topic)
 * @param {String} title title of message user sees on phone
 * @param {String} body  body message user sees on phone
 */
function sendFCMNotification(topic, title, body) {
  // Notification settings
  const notificationOptions = {
    priority: "high",
    timeToLive: 60 * 60 * 24,
  };

  // Notification message with title and body that users see
  const notificationMessage = {
    notification: {
      title: title,
      body: body,
      sound: "default",
    },
  };

  // Send the notification
  admin.messaging()
      .sendToTopic(
          topic,
          notificationMessage,
          notificationOptions);
}

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



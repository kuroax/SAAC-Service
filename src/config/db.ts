import mongoose from "mongoose";
import { MONGODB_URI, IS_DEVELOPMENT } from "#/config/env.js";
import { logger } from "#/config/logger.js";

const MONGOOSE_OPTIONS: mongoose.ConnectOptions = {
  autoIndex: IS_DEVELOPMENT,
};

mongoose.connection.on("connected", () => {
  logger.info("MongoDB connection established");
});

mongoose.connection.on("error", (err) => {
  logger.error({ err }, "MongoDB connection error");
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected");
});

mongoose.connection.on("reconnected", () => {
  logger.info("MongoDB reconnected");
});

export const connectDB = async (): Promise<void> => {
  try {
    mongoose.set("strictQuery", true);
    const conn = await mongoose.connect(MONGODB_URI, MONGOOSE_OPTIONS);
    logger.info(
      {
        host: conn.connection.host,
        name: conn.connection.name,
      },
      "MongoDB connected",
    );
  } catch (err) {
    logger.error({ err }, "MongoDB connection failed");
    process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.disconnect();
    logger.info("MongoDB disconnected successfully");
  } catch (err) {
    logger.error({ err }, "MongoDB disconnection failed");
    throw err;
  }
};

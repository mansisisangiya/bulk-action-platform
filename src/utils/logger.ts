import winston from "winston";
import { config } from "../config.js";

const { combine, timestamp, colorize, printf, json } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ level, message, timestamp, ...meta }) => {
    const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} [${level}] ${message}${extras}`;
  }),
);

export const logger = winston.createLogger({
  level: config.nodeEnv === "production" ? "info" : "debug",
  format: config.nodeEnv === "production" ? combine(timestamp(), json()) : devFormat,
  transports: [new winston.transports.Console()],
});

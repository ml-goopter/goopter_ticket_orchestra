#!/usr/bin/env node
// Thin entry: runs the built dist (Q7, no bundler). Logic lives in src/.
import process from "node:process";
import { main } from "../dist/cli.js";

process.exit(await main());

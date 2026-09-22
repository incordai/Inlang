#!/usr/bin/env node
import { main } from '../src/az.ts';
process.exitCode = main(process.argv.slice(2));

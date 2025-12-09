#!/usr/bin/env node
/**
 * Matter Controller Module
 * 
 * This module provides TypeScript functions to control Matter-compatible smart home devices.
 * It wraps the Matter Shell CLI tool, providing a clean async/await interface for:
 * - Turning lights on/off
 * - Toggling light state
 * - Reading current light state
 * - Listing commissioned devices
 * 
 * The module communicates with Matter devices through the Matter Shell, which handles
 * the low-level Matter protocol communication.
 * 
 * @module matter-controller
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

// ============================================================================
// CONFIGURATION CONSTANTS
// ============================================================================

/**
 * Default Node ID for the Matter light device.
 * This is the unique identifier assigned to your light during the Matter commissioning process.
 * 
 * HOW TO FIND YOUR NODE ID:
 * 1. Run: npx matter-shell
 * 2. In the shell, type: nodes list
 * 3. Copy the Node ID of your device
 * 
 * IMPORTANT: Replace this with your actual device's Node ID
 */
export const DEFAULT_LIGHT_NODE_ID: string = '6116695569389679211';

/**
 * Default Endpoint ID for the light device.
 * 
 * WHAT IS AN ENDPOINT?
 * In Matter protocol, a single physical device can have multiple "endpoints".
 * Each endpoint represents a distinct functional unit within the device.
 * 
 * Examples:
 * - A smart light bulb typically has endpoint 1 for the light function
 * - A smart power strip might have endpoints 1, 2, 3, 4 for each outlet
 * - A combination device (e.g., light + fan) might have endpoint 1 for light, endpoint 2 for fan
 * 
 * For most single-function lights, endpoint 1 is correct.
 * If your device has multiple controllable parts, you may need to specify different endpoints.
 */
export const DEFAULT_ENDPOINT_ID: string = '1';

/**
 * Timeout in milliseconds to wait for the Matter Shell to process a command.
 * Increase this value if you experience timeout issues with slower devices or networks.
 */
const COMMAND_TIMEOUT_MS: number = 2000;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Result object returned by all Matter control operations.
 * Provides structured information about the operation outcome.
 */
export interface MatterCommandResult {
  /** Whether the command executed successfully */
  success: boolean;
  /** Human-readable message describing the result */
  message: string;
  /** Raw output from the Matter Shell (useful for debugging) */
  rawOutput: string;
  /** Error message if the command failed */
  error?: string;
}

/**
 * Result object specifically for light state queries.
 * Extends MatterCommandResult with state information.
 */
export interface LightStateResult extends MatterCommandResult {
  /** Current state of the light: true = ON, false = OFF, undefined = unknown */
  isOn?: boolean;
}

// ============================================================================
// CORE SHELL INTERACTION
// ============================================================================

/**
 * Executes a command in the Matter Shell.
 * 
 * This function handles the complexity of:
 * 1. Spawning the Matter Shell process
 * 2. Waiting for the shell to initialize (indicated by 'matter>' prompt)
 * 3. Sending the command
 * 4. Collecting and filtering the output
 * 5. Gracefully exiting the shell
 * 
 * @param cmd - The Matter Shell command to execute (e.g., 'c onoff on 123 1')
 * @returns Promise resolving to the filtered command output
 * @throws Error if the shell process fails or exits with non-zero code
 * 
 * @example
 * // Turn on a light
 * const output = await executeShellCommand('c onoff on 6116695569389679211 1');
 * 
 * @example
 * // List all devices
 * const output = await executeShellCommand('nodes list');
 */
async function executeShellCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Spawn the Matter Shell process
    // Using 'npx' ensures we use the locally installed version
    const shell: ChildProcessWithoutNullStreams = spawn('npx', ['@matter/nodejs-shell'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Buffers to collect output
    let output: string = '';
    let errorOutput: string = '';
    
    // Flag to track if shell is ready to receive commands
    let isReady: boolean = false;

    // Handle standard output from the shell
    shell.stdout.on('data', (data: Buffer) => {
      const text: string = data.toString();
      output += text;
      
      // The 'matter>' prompt indicates the shell is ready for commands
      if (text.includes('matter>')) {
        if (!isReady) {
          isReady = true;
          
          // Shell is initialized, send our command
          shell.stdin.write(cmd + '\n');
          
          // Wait for command to process, then exit gracefully
          // This timeout allows the command to complete before we close the shell
          setTimeout(() => {
            shell.stdin.write('exit\n');
          }, COMMAND_TIMEOUT_MS);
        }
      }
    });

    // Capture any error output (useful for debugging)
    shell.stderr.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    // Handle shell process completion
    shell.on('close', (code: number | null) => {
      // Filter the output to remove shell noise and keep only relevant information
      const filteredLines: string = output
        .split('\n')
        .filter((line: string) => {
          // Remove various shell startup messages and internal logs
          return !line.includes('INFO') &&      // Info-level logs
                 !line.includes('WARN') &&      // Warning logs
                 !line.includes('NOTICE') &&    // Notice logs
                 !line.includes('matter>') &&   // Shell prompts
                 !line.includes('Started Node') && // Startup messages
                 !line.includes('Loaded') &&    // Loading messages
                 !line.includes('history entries') && // History messages
                 !line.includes('Opened') &&    // File open messages
                 !line.includes('storage at') && // Storage path messages
                 line.trim() !== '';            // Empty lines
        })
        .join('\n')
        .trim();

      // Resolve or reject based on exit code
      if (code === 0) {
        resolve(filteredLines);
      } else {
        reject(new Error(`Matter Shell exited with code ${code}. Error: ${errorOutput}`));
      }
    });

    // Handle process spawn errors
    shell.on('error', (error: Error) => {
      reject(new Error(`Failed to spawn Matter Shell: ${error.message}`));
    });
  });
}

// ============================================================================
// PUBLIC API FUNCTIONS
// ============================================================================

/**
 * Turns the light ON.
 * 
 * Sends the 'on' command to the OnOff cluster of the specified Matter device.
 * 
 * @param nodeId - The Matter Node ID of the device (defaults to DEFAULT_LIGHT_NODE_ID)
 * @param endpointId - The endpoint ID on the device (defaults to DEFAULT_ENDPOINT_ID)
 * @returns Promise resolving to the operation result
 * 
 * @example
 * // Turn on the default light
 * const result = await turnOnLight();
 * if (result.success) {
 *   console.log('Light is now ON');
 * }
 * 
 * @example
 * // Turn on a specific light
 * const result = await turnOnLight('1234567890', '2');
 */
export async function turnOnLight(
  nodeId: string = DEFAULT_LIGHT_NODE_ID,
  endpointId: string = DEFAULT_ENDPOINT_ID
): Promise<MatterCommandResult> {
  // Log to stderr to avoid interfering with MCP STDIO communication
  console.error(`[Matter Controller] Turning ON light - Node: ${nodeId}, Endpoint: ${endpointId}`);
  
  try {
    // Execute the OnOff cluster 'on' command
    // Command format: c onoff on <nodeId> <endpointId>
    // 'c' is short for 'cluster command'
    const rawOutput = await executeShellCommand(`c onoff on ${nodeId} ${endpointId}`);
    
    console.error(`[Matter Controller] Light ON command successful`);
    
    return {
      success: true,
      message: `Successfully turned ON light (Node: ${nodeId}, Endpoint: ${endpointId})`,
      rawOutput
    };
  } catch (error) {
    // Extract error message safely
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Matter Controller] Failed to turn on light: ${errorMessage}`);
    
    return {
      success: false,
      message: `Failed to turn ON light`,
      rawOutput: '',
      error: errorMessage
    };
  }
}

/**
 * Turns the light OFF.
 * 
 * Sends the 'off' command to the OnOff cluster of the specified Matter device.
 * 
 * @param nodeId - The Matter Node ID of the device (defaults to DEFAULT_LIGHT_NODE_ID)
 * @param endpointId - The endpoint ID on the device (defaults to DEFAULT_ENDPOINT_ID)
 * @returns Promise resolving to the operation result
 * 
 * @example
 * // Turn off the default light
 * const result = await turnOffLight();
 * if (result.success) {
 *   console.log('Light is now OFF');
 * }
 */
export async function turnOffLight(
  nodeId: string = DEFAULT_LIGHT_NODE_ID,
  endpointId: string = DEFAULT_ENDPOINT_ID
): Promise<MatterCommandResult> {
  console.error(`[Matter Controller] Turning OFF light - Node: ${nodeId}, Endpoint: ${endpointId}`);
  
  try {
    // Execute the OnOff cluster 'off' command
    const rawOutput = await executeShellCommand(`c onoff off ${nodeId} ${endpointId}`);
    
    console.error(`[Matter Controller] Light OFF command successful`);
    
    return {
      success: true,
      message: `Successfully turned OFF light (Node: ${nodeId}, Endpoint: ${endpointId})`,
      rawOutput
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Matter Controller] Failed to turn off light: ${errorMessage}`);
    
    return {
      success: false,
      message: `Failed to turn OFF light`,
      rawOutput: '',
      error: errorMessage
    };
  }
}

/**
 * Toggles the light state.
 * 
 * If the light is ON, it will be turned OFF.
 * If the light is OFF, it will be turned ON.
 * 
 * This is useful when you don't know or care about the current state
 * and just want to switch it.
 * 
 * @param nodeId - The Matter Node ID of the device (defaults to DEFAULT_LIGHT_NODE_ID)
 * @param endpointId - The endpoint ID on the device (defaults to DEFAULT_ENDPOINT_ID)
 * @returns Promise resolving to the operation result
 * 
 * @example
 * // Toggle the default light
 * const result = await toggleLight();
 * console.log(result.message); // "Successfully toggled light..."
 */
export async function toggleLight(
  nodeId: string = DEFAULT_LIGHT_NODE_ID,
  endpointId: string = DEFAULT_ENDPOINT_ID
): Promise<MatterCommandResult> {
  console.error(`[Matter Controller] Toggling light - Node: ${nodeId}, Endpoint: ${endpointId}`);
  
  try {
    // Execute the OnOff cluster 'toggle' command
    const rawOutput = await executeShellCommand(`c onoff toggle ${nodeId} ${endpointId}`);
    
    console.error(`[Matter Controller] Light toggle command successful`);
    
    return {
      success: true,
      message: `Successfully toggled light (Node: ${nodeId}, Endpoint: ${endpointId})`,
      rawOutput
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Matter Controller] Failed to toggle light: ${errorMessage}`);
    
    return {
      success: false,
      message: `Failed to toggle light`,
      rawOutput: '',
      error: errorMessage
    };
  }
}

/**
 * Gets the current state of the light.
 * 
 * Reads the 'onOff' attribute from the OnOff cluster to determine
 * whether the light is currently ON or OFF.
 * 
 * @param nodeId - The Matter Node ID of the device (defaults to DEFAULT_LIGHT_NODE_ID)
 * @param endpointId - The endpoint ID on the device (defaults to DEFAULT_ENDPOINT_ID)
 * @returns Promise resolving to the state result, including isOn boolean
 * 
 * @example
 * // Check if the light is on
 * const result = await getLightState();
 * if (result.success && result.isOn !== undefined) {
 *   console.log(`Light is ${result.isOn ? 'ON' : 'OFF'}`);
 * }
 */
export async function getLightState(
  nodeId: string = DEFAULT_LIGHT_NODE_ID,
  endpointId: string = DEFAULT_ENDPOINT_ID
): Promise<LightStateResult> {
  console.error(`[Matter Controller] Getting light state - Node: ${nodeId}, Endpoint: ${endpointId}`);
  
  try {
    // Read the onOff attribute from the OnOff cluster
    // Command format: a read <nodeId> <endpointId> <clusterName> <attributeName>
    // 'a' is short for 'attribute'
    const rawOutput = await executeShellCommand(`a read ${nodeId} ${endpointId} onoff onOff`);
    
    console.error(`[Matter Controller] Light state query successful: ${rawOutput}`);
    
    // Parse the output to determine state
    // The output typically contains 'true' or 'false' for the onOff attribute
    const isOn = rawOutput.toLowerCase().includes('true') || 
                 rawOutput.includes('1') && !rawOutput.includes('endpoint 1');
    
    const stateText = isOn ? 'ON' : 'OFF';
    
    return {
      success: true,
      message: `Light is currently ${stateText} (Node: ${nodeId}, Endpoint: ${endpointId})`,
      rawOutput,
      isOn
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Matter Controller] Failed to get light state: ${errorMessage}`);
    
    return {
      success: false,
      message: `Failed to get light state`,
      rawOutput: '',
      error: errorMessage,
      isOn: undefined
    };
  }
}

/**
 * Lists all commissioned Matter devices.
 * 
 * This is useful for discovering available devices and their Node IDs.
 * Note: Devices must be commissioned before they appear in this list.
 * 
 * @returns Promise resolving to the list of devices
 * 
 * @example
 * // List all devices
 * const result = await listDevices();
 * console.log(result.rawOutput); // Shows all commissioned devices
 */
export async function listDevices(): Promise<MatterCommandResult> {
  console.error(`[Matter Controller] Listing all commissioned devices`);
  
  try {
    const rawOutput = await executeShellCommand('nodes list');
    
    console.error(`[Matter Controller] Device list retrieved successfully`);
    
    return {
      success: true,
      message: 'Successfully retrieved device list',
      rawOutput: rawOutput || 'No devices found. Make sure you have commissioned at least one device.'
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Matter Controller] Failed to list devices: ${errorMessage}`);
    
    return {
      success: false,
      message: 'Failed to list devices',
      rawOutput: '',
      error: errorMessage
    };
  }
}

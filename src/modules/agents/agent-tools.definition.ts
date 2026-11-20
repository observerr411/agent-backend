import { AITool } from '../ai/interfaces/ai-provider.interface.js';

export const AGENT_TOOLS: AITool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file from repo root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file. IMPORTANT: Only use for files under 150 lines. For larger files use run_command with a Python heredoc: run_command({command: "python3 -c \\"open(\'path\',\'w\').write(\'\'\'...content...\'\'\')\\""})',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file from repo root (do NOT use absolute paths)' },
          content: { type: 'string', description: 'Full file content to write (keep under 150 lines)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a given path',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to list (default: .)' },
          recursive: { type: 'boolean', description: 'List recursively' },
          maxDepth: { type: 'number', description: 'Max depth for recursive listing' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Search for text patterns in the codebase using grep',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or literal string to search for' },
          path: { type: 'string', description: 'Directory to search in (default: .)' },
          filePattern: { type: 'string', description: 'File glob pattern like *.ts' },
          caseSensitive: { type: 'boolean', description: 'Case-sensitive search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the repository directory',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          workingDir: { type: 'string', description: 'Working directory (default: repo root)' },
          timeout: { type: 'number', description: 'Timeout in seconds (max 900). Use 600+ for Rust/JVM builds.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run the test suite. Auto-detects npm/pytest/go/cargo. For Rust projects allow up to 10 minutes — compilation is slow.',
      parameters: {
        type: 'object',
        properties: {
          testPath: { type: 'string', description: 'Specific test file, module, or test name filter to run' },
          flags: { type: 'string', description: 'Additional flags to pass to the test runner' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_git_diff',
      description: 'Get the current git diff to see what changes have been made',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes only' },
          path: { type: 'string', description: 'Specific path to diff' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_package',
      description: 'Read package.json, requirements.txt, go.mod, or other dependency files',
      parameters: {
        type: 'object',
        properties: {
          packageFile: { type: 'string', description: 'Path to the dependency file' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the repository',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete' },
          reason: { type: 'string', description: 'Reason for deletion' },
        },
        required: ['path', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Get the current git status',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

export const READ_ONLY_TOOLS = AGENT_TOOLS.filter((t) =>
  ['read_file', 'list_directory', 'search_codebase', 'get_git_diff', 'git_status', 'inspect_package'].includes(
    t.function.name,
  ),
);

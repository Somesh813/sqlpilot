/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^@sqlpilot/shared$': '<rootDir>/../shared/src/index.ts',
  },
  testMatch: ['**/*.spec.ts'],
  testTimeout: 60000,
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: { types: ['jest', 'node'], esModuleInterop: true } }],
  },
};

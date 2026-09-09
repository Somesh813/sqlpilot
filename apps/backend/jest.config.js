/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  moduleNameMapper: {
    '^@sqlpilot/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@sqlpilot/sql-parser$': '<rootDir>/../../packages/sql-parser/src/index.ts',
    '^@sqlpilot/ai$': '<rootDir>/../../packages/ai/src/index.ts',
    '^@sqlpilot/database$': '<rootDir>/../../packages/database/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
};

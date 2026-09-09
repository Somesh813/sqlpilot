import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@sqlpilot/shared';

export const ROLES_KEY = 'roles';

/** Restricts a route to the given roles. Requires RolesGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** @module features/auth/schemas — form schemas derived from the contracts request shapes */
import {
  ChangePasswordRequest,
  LoginRequest,
  PASSWORD_MIN_LENGTH,
} from '@browserhive/contracts/http';
import { z } from 'zod';

/** Login form. */
export const loginForm = LoginRequest;
/** Login form values. */
export type LoginForm = z.infer<typeof loginForm>;

/** Change-password form: the contracts body plus a confirmation field. */
export const changePasswordForm = ChangePasswordRequest.extend({
  current_password: ChangePasswordRequest.shape.current_password.min(
    1,
    'Enter your current password.',
  ),
  new_password: ChangePasswordRequest.shape.new_password.min(
    PASSWORD_MIN_LENGTH,
    `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  ),
  confirm_password: z.string().min(1, 'Repeat the new password.'),
}).refine((v) => v.new_password === v.confirm_password, {
  message: 'New passwords do not match.',
  path: ['confirm_password'],
});
/** Change-password form values. */
export type ChangePasswordForm = z.infer<typeof changePasswordForm>;

/** Minimum length shown in hints. */
export const MIN_PASSWORD = PASSWORD_MIN_LENGTH;

/** @module lib/api/operations-templates — the session-template operations of `HTTP_ENDPOINTS` (spec 13 §11.1), spread into `OPERATIONS` */
import {
  ConfirmRecordingRequest,
  ConfirmRecordingResponse,
  DeleteTemplateQuery,
  DeleteTemplateResponse,
  FinishRecordingRequest,
  FinishRecordingResponse,
  RemoveSignInResponse,
  StartRecordingRequest,
  StartRecordingResponse,
  TemplateDetailResponse,
  TemplateDomainParams,
  TemplateIdParams,
  TemplateInput,
  TemplateOkResponse,
  TemplateResponse,
  TemplatesPage,
  TemplatesQuery,
} from '@browserhive/contracts/http';

/** Template routes (spec 13 §11.1, the T1a rows). */
export const TEMPLATE_OPERATIONS = {
  listTemplates: { query: TemplatesQuery, response: TemplatesPage },
  createTemplate: { body: TemplateInput, response: TemplateResponse },
  getTemplate: { params: TemplateIdParams, response: TemplateDetailResponse },
  deleteTemplate: {
    params: TemplateIdParams,
    query: DeleteTemplateQuery,
    response: DeleteTemplateResponse,
  },
  removeTemplateSignIn: { params: TemplateDomainParams, response: RemoveSignInResponse },
  startTemplateRecording: {
    params: TemplateIdParams,
    body: StartRecordingRequest,
    response: StartRecordingResponse,
  },
  confirmTemplateRecording: {
    params: TemplateIdParams,
    body: ConfirmRecordingRequest,
    response: ConfirmRecordingResponse,
  },
  finishTemplateRecording: {
    params: TemplateIdParams,
    body: FinishRecordingRequest,
    response: FinishRecordingResponse,
  },
  cancelTemplateRecording: { params: TemplateIdParams, response: TemplateOkResponse },
  clearTemplateProfileSecrets: { params: TemplateIdParams, response: TemplateOkResponse },
} as const;

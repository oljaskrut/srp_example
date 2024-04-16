import { TextContentBlock, TextDelta } from 'openai/resources/beta/threads/messages/messages';
import { RetrievalTool } from 'openai/resources/beta/assistants/assistants';
import _ from 'lodash';
import { UserActions } from '../../models/message';
import { addMessage } from '../chat/addMessage';
import { createThreadMessage } from '../../externalSevices/open-ai/threads/createThreadMessage';
import { AssistantStatuses } from '../../const/assistant/AssistantStatuses';
import { getChatAssistant } from './getChatAssistant';
import { AssistantBusyError, AssistantNotFoundError } from '../../utils/errors/AssistantErrors';
import { publishChatMessage, publishCreateChatMessage } from '../../broker/chat/publisher';
import { updateAssistantStatusWithNotify } from './updateAssistantStatusWithNotify';
import { createStreamRun } from '../../externalSevices/open-ai/threads/createStreamRun';
import { INSTRUCTIONS_FILES_ATTACHED } from '../../const/assistant/instructions';

interface IArgs {
    chat: string;
    content: string;
    user: string;
    files?: string[];
}

const UPDATE_MESSAGE_DEBOUNCE_TIME = 500;
const SEND_MESSAGE_DEBOUNCE_TIME = 30;

export const sendAssistantResponse = async ({ chat, content, user, files }: IArgs): Promise<void> => {
    try {
        const aiAssistant = await getChatAssistant({ chat });

        if ([AssistantStatuses.pending, AssistantStatuses.answering].includes(aiAssistant.status)) {
            throw new AssistantBusyError();
        }

        await updateAssistantStatusWithNotify({ chat, status: AssistantStatuses.pending, userId: user });

        const isFileAttached = files && files.length !== 0;

        if (content) {
            if (isFileAttached) {
                const userMessage = await addMessage({
                    chat,
                    content: `${content}. files:${files.join(',')}`,
                    fileIds: files,
                });
                await publishCreateChatMessage({ userId: user, message: userMessage, chatId: chat });
                await createThreadMessage(aiAssistant.thread, '', files);
                await createThreadMessage(aiAssistant.thread, content, files);
            } else {
                const userMessage = await addMessage({ chat, content });
                await publishCreateChatMessage({ userId: user, message: userMessage, chatId: chat });
                await createThreadMessage(aiAssistant.thread, content);
            }
        }

        const options = isFileAttached
            ? {
                  tools: [{ type: 'retrieval' } as RetrievalTool],
                  additional_instructions: INSTRUCTIONS_FILES_ATTACHED,
              }
            : undefined;

        const run = createStreamRun(aiAssistant.assistantId, aiAssistant.thread, options);

        run.on('error', async (error) => {
            throw error;
        });

        const aiMessage = await addMessage({
            chat,
            content: '',
            userAction: UserActions.RECEIVE,
        });

        const updateMessageContent = _.debounce(async (contentNew: string) => {
            aiMessage.content = contentNew;
            await aiMessage.save();
        }, UPDATE_MESSAGE_DEBOUNCE_TIME);

        const sendChatMessage = _.debounce(async (contentNew: string) => {
            await publishChatMessage({ userId: user, content: contentNew, chatId: chat, messageId: aiMessage._id });
        }, SEND_MESSAGE_DEBOUNCE_TIME);

        const answerArray: string[] = [];

        /* if textDelta event is after textCreated event then the first chunk 
        won't be added to the answerArray so the interim message won't be full on the frontend */
        run.on('textDelta', async (textDelta) => {
            answerArray.push(textDelta.value || '');
            const answer = answerArray.join('');
            await updateMessageContent(answer);
            await sendChatMessage(answer);
        });

        const firstContentPart: TextDelta = await new Promise((resolve) => {
            run.on('textCreated', (textDelta) => resolve(textDelta as TextDelta));
        });

        aiMessage.content = firstContentPart.value || '';

        await aiMessage.save();

        await publishCreateChatMessage({ userId: user, message: aiMessage, chatId: chat });

        await updateAssistantStatusWithNotify({ chat, status: AssistantStatuses.answering, userId: user });

        let wasDone = false;

        run.on('messageDone', async (message) => {
            const answer = (message.content.filter((c) => c.type === 'text') as TextContentBlock[])
                .map((c: TextContentBlock) => c.text.value)
                .join('\n');

            answerArray.push('\n');
            if (wasDone) return;

            await sendChatMessage(answer);
            await updateMessageContent(answer);
            await updateAssistantStatusWithNotify({ chat, status: AssistantStatuses.complete, userId: user });
            wasDone = true;
        });
    } catch (error) {
        if (!(error instanceof AssistantNotFoundError) && !(error instanceof AssistantBusyError)) {
            await updateAssistantStatusWithNotify({ chat, status: AssistantStatuses.error, userId: user });
        }
        throw error;
    }
};
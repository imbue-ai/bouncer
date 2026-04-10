import { ChatConfig, ConvTemplateConfig, Role } from "./config";
import { ChatCompletionContentPart, ChatCompletionContentPartImage, ChatCompletionRequest } from "./openai_api_protocols/index";
type ImageURL = ChatCompletionContentPartImage.ImageURL;
/**
 * Helper to keep track of history conversations.
 */
export declare class Conversation {
    /** Each message is a tuple of (Role, role_name_str, message), where message can be either a
     *  string or an array of contentPart for possible image input.
     */
    messages: Array<[
        Role,
        string,
        string | Array<ChatCompletionContentPart> | undefined
    ]>;
    readonly config: ConvTemplateConfig;
    /** Whether the Conversation object is for text completion with no conversation-style formatting */
    isTextCompletion: boolean;
    /** Used when isTextCompletion is true */
    prompt: string | undefined;
    function_string: string;
    use_function_calling: boolean;
    override_system_message?: string;
    /**
     * Tracks whether the last message is an empty thinking block. Should only
     * be true when we are in the middle of a generation. Will be set to
     * false when the reply is finished with `finishReply()`.
     */
    private isLastMessageEmptyThinkingReplyHeader;
    constructor(config: ConvTemplateConfig, isTextCompletion?: boolean);
    private getPromptArrayInternal;
    /**
     * Get prompt arrays with the first one as system.
     *
     * It is returned as an array of `string | Array<string | ImageURL>`, where each element of
     * the array represents the formatted message of a role/turn. If the message only contains text,
     * it will be a string that concatenates the role string, message, and separators. If the
     * message contains image(s), it will be an array of string and ImageURL in the order of which
     * they will be prefilled into the model. e.g. it can be something like
     * [
     *   "<|system|>\nSome system prompt\n",
     *   [
     *     "<|user|>\n",
     *     imageURL1,
     *     "\n",
     *     imageURL2,
     *     "\n",
     *     "Some user input<|end|>\n"
     *   ],
     * ]
     *
     * @returns The prompt array.
     */
    getPromptArray(): Array<string | Array<string | ImageURL>>;
    /**
     * Get the last round of prompt has not been fed as input.
     *
     * @note This function needs to be used with the assumption that
     *       the caller call appendMessage then appendReplyHeader.
     *
     * @returns The prompt array.
     */
    getPromptArrayLastRound(): (string | (string | ChatCompletionContentPartImage.ImageURL)[])[];
    /**
     * Return prompt in an array for non-conversation text completion.
     */
    getPromptArrayTextCompletion(): Array<string>;
    /**
     * Resets all states for this.conversation.
     */
    reset(): void;
    getStopStr(): string[];
    getStopTokens(): number[];
    appendMessage(role: Role, message: string | Array<ChatCompletionContentPart>, role_name?: string): void;
    appendReplyHeader(role: Role): void;
    appendEmptyThinkingReplyHeader(role: Role, emptyThinkingBlockStr: string): void;
    finishReply(message: string): void;
}
export declare function getConversation(conv_template: ConvTemplateConfig, conv_config?: Partial<ConvTemplateConfig>, isTextCompletion?: boolean): Conversation;
/**
 * Compare the states of two conversation instances. Equality is defined as their getPromptArray()
 * should return the exact same things, which is determined by fields: messages, function_string,
 * use_function_calling, and override_system_message.
 *
 * @returns True if `convA` equals to `convB`
 * @note We assume convA and convB has the same `this.config`.
 */
export declare function compareConversationObject(convA: Conversation, convB: Conversation): boolean;
/**
 * Get a new Conversation object based on the chat completion request.
 *
 * @param request The incoming ChatCompletionRequest
 * @param includeLastMsg Include last message, by default is false. Set to true for testing only.
 * @note By default, `request.messages[-1]` is not included as it would be treated as a normal
 * input to `prefill()`.
 */
export declare function getConversationFromChatCompletionRequest(request: ChatCompletionRequest, config: ChatConfig, includeLastMsg?: boolean): Conversation;
/**
 * Returns the function string based on the request.tools and request.tool_choice, raises erros if
 * encounter invalid request.
 *
 * @param request The chatCompletionRequest we are about to prefill for.
 * @returns The string used to set Conversation.function_string
 */
export declare function getFunctionCallUsage(request: ChatCompletionRequest): string;
export {};
//# sourceMappingURL=conversation.d.ts.map
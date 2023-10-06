import { profanity } from '@2toad/profanity';

export const promptIsClean = (prompt: string) => {
    return !profanity.exists(prompt);
}
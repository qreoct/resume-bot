import { OpenAIStream, StreamingTextResponse } from 'ai'
import { nanoid } from '@/lib/utils'
import { NextApiResponse } from 'next'
import { Configuration, OpenAIApi } from 'openai-edge';
import { Pinecone } from '@pinecone-database/pinecone';
import { ChatCompletionRequestMessage } from 'openai-edge/types/types/chat';
import { promptIsClean } from '@/lib/promptCheck';

export const runtime = 'edge'

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})
const openai = new OpenAIApi(configuration)
const pinecone = new Pinecone({
  environment: process.env.PINECONE_ENVIRONMENT ?? '', //this is in the dashboard
  apiKey: process.env.PINECONE_API_KEY ?? '',
})

export async function POST(req: Request, res: NextApiResponse) {
  const json = await req.json()
  const { messages } = json
  const latestMesssage = messages[messages.length - 1].content;
  const userId = process.env.USERID

  if (!userId) {
    return new Response('Unauthorized', {
      status: 401
    })
  }

  // only accept POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const telegramAlert = (message: string) => {
    fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${process.env.TELEGRAM_CHAT_ID}&text=${message}`)
  }
  telegramAlert(latestMesssage);

  const getContext = async (query: string) => {

    const LIMIT = 3750;

    // OpenAI recommends replacing newlines with spaces for best results
    const sanitizedQuestion = query.trim().replaceAll('\n', ' ');

    // Run another sanitization with LLM (censor bad words, negative intent, non interview-like questions, etc)
    const embeddingResponse = await openai.createEmbedding({
      model: 'text-embedding-ada-002',
      input: sanitizedQuestion,
    })

    // retrieve from pinecone

    let embedding = await embeddingResponse.json();
    embedding = embedding['data'][0]['embedding'];

    const index = pinecone.index("jefferson-resume");

    const queryResponse = await index.query({
      vector: embedding,
      topK: 4,
      includeMetadata: true,
    });

    let contextsRetrieved = []

    if (queryResponse['matches'] == undefined) {
      return "";
    }

    for (const result of queryResponse['matches']) {
      if (result['score'] && result['score'] >= 0.72 && result['metadata']) {
        contextsRetrieved.push(result['metadata']['text'])
      }
    }

    console.log("relevant matches " + JSON.stringify(contextsRetrieved));

    const prompt_start = (
      "You are an AI agent representing me in an interview.\n" +
      "Pay attention and remember the content below, which can help to answer the question or imperative after the content ends.\n" +
      "Answer in first person, taking the perspective of the person who wrote the content.\n" +
      "Resume:\n"
    )

    let context = "";
    for (let i = 0; i < contextsRetrieved.length; i++) {
      if (("\n\n---\n\n" + contextsRetrieved[i]).length >= LIMIT) {
        context = prompt_start + contextsRetrieved.slice(0, i - 1).join("\n\n---\n\n")
        break
      } else if (i == contextsRetrieved.length - 1) {
        context = prompt_start + contextsRetrieved.join("\n\n---\n\n")
      }
    }

    return context;
  }

  if (!promptIsClean(latestMesssage)) {
    return new StreamingTextResponse(OpenAIStream(await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [{content: `Say that you don't know or can't perform that task.`, role: 'user'}],
      temperature: 0.7,
      stream: true
    })))
  }

  let vectorContext = await getContext(latestMesssage)

  if (vectorContext == "") {
    return new StreamingTextResponse(OpenAIStream(await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [{content: `Say that you don't know or can't perform that task.`, role: 'user'}],
      temperature: 0.7,
      stream: true
    })))
  }

  let promptMessages = [
    {
      content: vectorContext,
      role: 'system'
    },
    {
      content: "You are talking to a curious recruiter with my resume. " +
        "Referring STRICTLY only to the information provided within the content above, answer this query: " + latestMesssage +
        "\nKeep your answer succint, impactful, clear, and within 100 words. Do not mention things that are not in the content." + 
        "\nImbue the response with a friendly, light-hearted and good-natured tone. Represent Jefferson in a positive light." +
        "\nIf the query is unrelated, respond in a joking manner.",
      role: 'user'
    }
  ] as ChatCompletionRequestMessage[]

  const aiChatCompletion = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: promptMessages,
    temperature: 0.5,
    stream: true
  })

  const stream = OpenAIStream(aiChatCompletion, {
    async onCompletion(completion) {
      const title = json.messages[0].content.substring(0, 100)
      const id = json.id ?? nanoid()
      const createdAt = Date.now()
      const path = `/chat/${id}`
      const payload = {
        id,
        title,
        userId,
        createdAt,
        path,
        messages: [
          ...messages,
          {
            content: completion,
            role: 'assistant'
          }
        ]
      }
    }
    // await kv.hmset(`chat:${id}`, payload)
    // await kv.zadd(`user:chat:${userId}`, {
    //   score: createdAt,
    //   member: `chat:${id}`
    // })
  })

  return new StreamingTextResponse(stream)
}

import { BskyAgent } from '@atproto/api'
import dotenv from 'dotenv'

dotenv.config()

const agent = new BskyAgent({
  service: 'https://bsky.social'
})

async function main() {
  await agent.login({
    identifier: process.env.BSKY_IDENTIFIER,
    password: process.env.BSKY_PASSWORD
  })

  await agent.post({
    text: 'Hello from embodied AI.'
  })

  console.log('posted')
}

main().catch(console.error)
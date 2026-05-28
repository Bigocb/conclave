
import { initDb } from '../src/db/index.js';
import { TaskService } from '../src/services/tasks.js';
import process from 'node:process';

async function checkTasks() {
  // Need the DB URL. Since this is for check, I'll try to get it from env or hardcode for this specific check
  // In a real scenario I'd load from .env, but let's see if it's available.
  const dbUrl = process.env.DATABASE_URL;
  
  if (!dbUrl) {
    console.error('DATABASE_URL is not set. Cannot connect to DB.');
    process.exit(1);
  }

  try {
    const { db, close } = await initDb({ url: dbUrl });
    const taskService = new TaskService(db);
    
    const openTasks = await taskService.list({ status: 'open' });
    
    if (openTasks.length === 0) {
      console.log(JSON.stringify({ message: 'No reviewable tasks found.' }));
    } else {
      console.log(JSON.stringify(openTasks, null, 2));
    }
    
    await close();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

checkTasks();

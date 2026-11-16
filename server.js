import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';

dotenv.config();

const app = express();
const upload = multer({ dest: 'uploads/' }); // 暫存上傳的發票圖片

// 初始化 Supabase 與 Gemini AI
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

// 託管 public 資料夾底下的靜態網頁 (index.html)
app.use(express.static('public'));

// 1. API：取得所有歷史發票清單（依日期由新到舊排序）
app.get('/api/invoices', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('invoices')
            .select('*')
            .order('invoice_date', { ascending: false })
            .order('invoice_time', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('取得發票清單失敗:', err);
        res.status(500).json({ error: err.message });
    }
});

// 2. API：根據發票 ID 取得對應的消費明細與分類
app.get('/api/invoice-items/:invoiceId', async (req, res) => {
    try {
        const { invoiceId } = req.params;
        const { data, error } = await supabase
            .from('invoice_items')
            .select('*')
            .eq('invoice_id', invoiceId);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error('取得消費明細失敗:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3. API：上傳發票圖片 ➔ Gemini 3.8 Flash 視覺辨識 ➔ 寫入 Supabase
app.post('/api/upload-invoice', upload.single('invoice'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: '未收到圖片檔案' });
    }

    const filePath = req.file.path;
    const mimeType = req.file.mimetype;

    try {
        // 將圖片轉為 base64 格式
        const fileBuffer = fs.readFileSync(filePath);
        const base64Data = fileBuffer.toString("base64");
        const imagePart = {
            inlineData: { data: base64Data, mimeType }
        };

        const prompt = `
        你是一個專業的發票光學辨識 (OCR) 與資料標準化 AI 助手。請直接觀察這張發票圖片，萃取並標準化以下欄位：
        1. 將日期轉換為標準格式 (YYYY-MM-DD)，民國轉西元（例如 115年 = 2026年）。
        2. 將賣方名稱清洗簡化為標準名稱（例如：統一超商、全家便利商店、好樂迪KTV等）。
        3. 解析所有購買品項的名稱、數量、單價、小計。
        4. 依據消費性質將每個品項分類到對應的 category_id（例如：餐飲美食請填 "CAT_FOOD_DRINK"、娛樂消費填 "CAT_ENTERTAINMENT"、交通出行填 "CAT_TRANSPORT"、日用購物填 "CAT_SHOPPING"、其他填 "CAT_OTHER"）。

        請嚴格回傳標準的 JSON 格式，不要包含任何 markdown 標籤（如 \`\`\`json 等）或額外文字，格式如下：
        {
          "invoice_number": "AB12345678",
          "invoice_date": "2026-11-09",
          "invoice_time": "14:30:00",
          "seller_name": "全家便利商店",
          "seller_ubn": "23060248",
          "total_amount": 85,
          "carrier_type": "PAPER_INVOICE",
          "status": "PAID",
          "items": [
            {
              "original_name": "發票上的原始商品名稱",
              "standard_name": "標準化品項名稱",
              "category_id": "CAT_FOOD_DRINK",
              "subcategory_id": "SUBCAT_BEVERAGE",
              "quantity": 1,
              "unit_price": 35,
              "amount": 35
            }
          ]
        }
        `;

        // 呼叫 Gemini 3.8 Flash 模型進行辨識
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: [prompt, imagePart],
            config: { temperature: 0.1 }
        });

        let cleanDataText = response.text.trim();
        cleanDataText = cleanDataText.replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "");
        const cleanedData = JSON.parse(cleanDataText);

        // 寫入 Supabase 發票主表
        const { data: invoiceResult, error: invoiceError } = await supabase
            .from('invoices')
            .insert([{
                invoice_number: cleanedData.invoice_number,
                invoice_date: cleanedData.invoice_date,
                invoice_time: cleanedData.invoice_time,
                seller_name: cleanedData.seller_name,
                seller_ubn: cleanedData.seller_ubn,
                total_amount: cleanedData.total_amount,
                carrier_type: cleanedData.carrier_type,
                status: cleanedData.status
            }])
            .select('id')
            .single();

        if (invoiceError) throw invoiceError;

        const invoiceId = invoiceResult.id;

        // 寫入 Supabase 消費明細表
        if (cleanedData.items && cleanedData.items.length > 0) {
            const itemsToInsert = cleanedData.items.map(item => ({
                invoice_id: invoiceId,
                original_name: item.original_name,
                standard_name: item.standard_name,
                category_id: item.category_id,
                subcategory_id: item.subcategory_id,
                quantity: item.quantity,
                unit_price: item.unit_price,
                amount: item.amount
            }));

            const { error: itemsError } = await supabase.from('invoice_items').insert(itemsToInsert);
            if (itemsError) throw itemsError;
        }

        // 刪除暫存圖片
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        res.json({ success: true, data: cleanedData });
    } catch (err) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        console.error('辨識或入庫過程發生錯誤:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 支援雲端動態分配的 PORT，本機測試預設為 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 智慧發票伺服器已在連接埠 ${PORT} 啟動！`);
});
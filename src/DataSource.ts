import defaults from 'lodash/defaults';
import { getBackendSrv } from '@grafana/runtime';

import {
  DataQueryRequest,
  dateTimeParse,
  DataQueryResponse,
  DataQueryResponseData,
  DataSourceApi,
  DataSourceInstanceSettings,
  MutableDataFrame,
  FieldType,
  SelectableValue,
  toDataFrame,
} from '@grafana/data';

import flatten from './flatten';

import {
  DiscourseQuery,
  DiscourseDataSourceOptions,
  defaultQuery,
  DiscourseReports,
  DiscourseTags,
  QueryType,
  DiscourseCategories,
  DiscourseBulkReports,
  DiscourseReportMultipleData,
  DiscourseReportData,
  isDiscourseReportMultipleData,
  isDiscourseReportData,
} from './types';

export class DiscourseDataSource extends DataSourceApi<DiscourseQuery, DiscourseDataSourceOptions> {
  constructor(private instanceSettings: DataSourceInstanceSettings<DiscourseDataSourceOptions>) {
    super(instanceSettings);
  }

  async query(options: DataQueryRequest<DiscourseQuery>): Promise<DataQueryResponse> {
    const { range } = options;
    const from = range!.from.format('YYYY-MM-DD');
    const to = range!.to.format('YYYY-MM-DD');

    const data: DataQueryResponseData[] = [];

    // Return a constant for each query.
    for (const target of options.targets) {
      const query = defaults(target, defaultQuery);
      if (query.hide) {
        continue;
      }

      if (query.queryType === QueryType.Report) {
        await this.executeReportQuery(query, from, to, data);
      } else if (query.queryType === QueryType.User) {
        await this.executeUserQuery(query, data);
      } else if (query.queryType === QueryType.Tags) {
        await this.executeTagsQuery(query, data);        
      } else if (query.queryType === QueryType.Tag) {
        await this.executeTagQuery(query, data);        
      }    
    }
    return { data };
  }

  private async executeTagsQuery(query: DiscourseQuery, data: any[]) {
      const result = await this.apiGet(`tags.json`);
      const frame = toDataFrame(result.data.tags);
      data.push(frame);
  }

  private async executeTagQuery(query: DiscourseQuery, data: any[]) {
    const result           = await this.apiGet(`tag/${query.tag}.json`);
    const first_topics     = result.data.topic_list.topics
    const more_results_url = result.data.topic_list.more_topics_url;
  
    if(more_results_url !== undefined){
      const route = "tag"
      const paginated_topics = await this.getPaginatedTopics(query, route)
      console.log(paginated_topics)
      
      const concat_results = await first_topics.concat(paginated_topics)
      console.log(concat_results)
      
      const merged = toDataFrame(concat_results)
      console.log(merged)
      
      data.push(merged)
    } else {
      data.push(first_topics)
    }
  }

  private async getPaginatedTopics(query: any, route: string) {
    let page: number = 1;
    let moreResults : any[] = []
    let currentResult: string = ""
    do {
      try {
        const request = await this.apiGet(`${route}/${query.tag}.json?page=${page}`);
        console.log(request);

        const data = request.data.topic_list.topics;             
        currentResult = request.data.topic_list.more_topics_url;

        moreResults.push(data); 

        console.log(moreResults);
        console.log(currentResult);

        page++;
        console.log(page)
      } catch (err) {
        console.error(`Oeps, something is wrong ${err}`);
      }
      // keep running until there's no next page
    } while (currentResult !== undefined);
    console.log(currentResult);
    console.log(page);

    const flattened = moreResults.flat()
    return flattened
  } 

  private async executeUserQuery(query: DiscourseQuery, data: any[]) {
    if (query.userQuery === 'topPublicUsers') {
      const result = await this.apiGet(`directory_items.json?period=${query.period || 'monthly'}&order=post_count`);
      const frame = toDataFrame(
        result.data.directory_items.reduce((arr: any, elem: any) => {
          arr.push(flatten(elem));
          return arr;
        }, [])
      );
      data.push(frame);
    } else {
      const result = await this.apiGet('admin/users/list/staff.json');
      const frame = toDataFrame(result.data);
      data.push(frame);
    }
  }

  private async executeReportQuery(query: DiscourseQuery, from: string, to: string, data: any[]) {
    //strip the .json from the end
    const reportName = query.reportName?.substring(0, query.reportName.length - 5);
    const limit = 1000;

    let filter = `reports[${reportName}][start_date]=${from}&reports[${reportName}][end_date]=${to}&reports[${reportName}][limit]=${limit}`;

    if (query.category && query.category !== 'All categories') {
      filter += `&reports[${reportName}][filters][category]=${query.category}&reports[${reportName}][filters][include_subcategories]=true`;
    }

    const requestUrl = `admin/reports/bulk.json?${filter}`;

    const result = await this.apiGet(requestUrl);

    const reports = (result.data as DiscourseBulkReports).reports;
    let series = reports.filter((d: any) => d.data);
    const defaultReportTitle = reports.length > 0 ? reports[0].title : '';

    for (const s of series) {
      if (s.data?.length > 0 && isDiscourseReportMultipleData(s.data[0])) {
        for (const d of s.data as DiscourseReportMultipleData[]) {
          this.convertToDataFrame(query, d.data, d.label ?? defaultReportTitle, data);
        }
      } else if (s.data?.length > 0 && isDiscourseReportData(s.data[0])) {
        this.convertToDataFrame(query, s.data as DiscourseReportData[], defaultReportTitle, data);
      }
    }
  }

  private convertToDataFrame(query: DiscourseQuery, d: DiscourseReportData[], displayName: string, data: any[]) {
    const frame = new MutableDataFrame({
      refId: query.refId,
      fields: [
        { name: 'time', type: FieldType.time },
        { name: 'value', type: FieldType.number, config: { displayName: displayName } },
      ],
    });

    for (const val of d) {
      frame.add({
        time: dateTimeParse(val.x, { timeZone: 'utc' }).valueOf(),
        value: val.y ?? 0,
      });
    }

    data.push(frame);
  }

  async testDatasource() {
    let result: any;

    try {
      result = await this.apiGet('admin/reports/topics_with_no_response.json');
    } catch (error) {
      console.log(error);
    }

    if (result?.data?.report?.title !== 'Topics with no response') {
      return {
        status: 'error',
        message: 'Invalid credentials. Failed with request to the Discourse API',
      };
    }

    return {
      status: 'success',
      message: 'Success',
    };
  }

  async getReportTypes(): Promise<Array<SelectableValue<string>>> {
    const reportOptions: Array<SelectableValue<string>> = [];
    try {
      const result: any = await this.apiGet('admin/reports.json');

      for (const rep of (result.data as DiscourseReports).reports) {
        reportOptions.push({
          label: rep.title,
          value: rep.type + '.json',
          description: rep.description,
        });
      }
    } catch (error) {
      console.log(error);
    }

    return reportOptions;
  }

  async getCategories(): Promise<Array<SelectableValue<string>>> {
    const categoryOptions: Array<SelectableValue<string>> = [];
    categoryOptions.push({
      label: 'All categories',
      value: 'All categories',
      description: '',
    });

    try {
      const result: any = await this.apiGet('categories.json');

      for (const category of (result.data as DiscourseCategories).category_list.categories) {
        categoryOptions.push({
          label: category.name,
          value: category.id.toString(),
          description: category.description,
        });
      }
    } catch (error) {
      console.log(error);
    }
    return categoryOptions;
  }

  async getTags(): Promise<Array<SelectableValue<any>>> {
    const tagOptions: Array<SelectableValue<any>> = [];
    tagOptions.push({
      label: 'All tags',
      value: 'All tags',
    });

    try {
      const result: any = await this.apiGet('tags.json');

      for (const tag of (result.data as DiscourseTags).tags) {
        tagOptions.push({
          label: tag.text,
          value: tag.id.toString(),
        });
      }
    } catch (error) {
      console.log(error);
    }

    return tagOptions;
  }

  async apiGet(path: string): Promise<any> {
    const result = await getBackendSrv().datasourceRequest({
      url: `${this.instanceSettings.url}/discourse/${path}`,
      method: 'GET',
    });

    return result;
  }
}

